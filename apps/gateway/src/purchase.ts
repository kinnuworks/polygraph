import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { Receipt } from "mppx";
import type { Sandbox } from "@nodeops-createos/sandbox";
import type { PurchaseGrant, SignedManifest } from "@polygraph/core";
import { config } from "./config.js";
import { publish } from "./events.js";
import { getOffer } from "./offers.js";
import { chargeCard, priceFor, refundPayment, tagPayment } from "./payments.js";
import { claimWarmWorker, noteCapacityLimit, yieldPooledWorker } from "./pool.js";
import { destroyWorker, forkWorker, isCapacityError, issueAccessToken, reseedWorker } from "./sandbox.js";

type PurchaseState = "active" | "refunded" | "done" | "expired";

interface Purchase {
  grant: PurchaseGrant;
  worker: Sandbox;
  state: PurchaseState;
  workerDestroyed: boolean;
  expiry: NodeJS.Timeout;
}

const purchases = new Map<string, Purchase>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function buyDescription(offerName: string): string {
  return `${offerName}: one job in a fresh worker forked from the offer's verified parent sandbox`;
}

/** Destroys the purchase's worker once; later calls are no-ops. */
async function releaseWorker(purchase: Purchase): Promise<boolean> {
  clearTimeout(purchase.expiry);
  if (purchase.workerDestroyed) return true;
  try {
    await destroyWorker(purchase.worker);
  } catch (err) {
    console.error(`[purchase] destroying ${purchase.worker.id} failed: ${errorMessage(err)}`);
    return false;
  }
  purchase.workerDestroyed = true;
  publish({ type: "worker.destroyed", workerSandboxId: purchase.worker.id });
  return true;
}

/**
 * Takes a pooled worker when one is ready, otherwise forks one now. If the account quota refuses the
 * fork, an idle pooled worker of another offer gives up its slot and the fork is tried once more.
 */
async function obtainWorker(offer: SignedManifest): Promise<{ worker: Sandbox; mode: "warm" | "cold" }> {
  const warm = await claimWarmWorker(offer);
  if (warm) return { worker: warm, mode: "warm" };
  const { parentSandboxId, offerId } = offer.manifest;
  try {
    return { worker: await forkWorker(parentSandboxId), mode: "cold" };
  } catch (err) {
    if (!isCapacityError(err)) throw err;
    noteCapacityLimit(`sale of ${offerId} hit the CreateOS quota (${errorMessage(err)})`);
    if (!(await yieldPooledWorker(offerId))) throw err;
    return { worker: await forkWorker(parentSandboxId), mode: "cold" };
  }
}

/**
 * Gets a worker, reseeds it and hands out a scoped token. Reseeding happens here, at sale time, so a
 * pooled worker never shares random state with the others. Any failure destroys the worker before rethrowing.
 */
async function provision(offer: SignedManifest, paymentIntentId: string, requestStartedAt: number): Promise<Purchase> {
  const { manifest } = offer;
  const { worker, mode } = await obtainWorker(offer);
  try {
    const { bootId } = await reseedWorker(worker);
    const workerToken = await issueAccessToken(worker.id);
    const ms = Math.round(performance.now() - requestStartedAt);
    const purchaseId = `pur_${randomUUID()}`;
    const grant: PurchaseGrant = {
      purchaseId,
      offerId: manifest.offerId,
      workerSandboxId: worker.id,
      workerToken,
      platformUrl: config.createos.baseUrl,
      paymentIntentId,
      expiresAt: new Date(Date.now() + config.purchaseTtlMs).toISOString(),
    };
    const purchase: Purchase = {
      grant,
      worker,
      state: "active",
      workerDestroyed: false,
      expiry: setTimeout(() => {
        if (purchase.state === "active") purchase.state = "expired";
        void releaseWorker(purchase);
      }, config.purchaseTtlMs).unref(),
    };
    purchases.set(purchaseId, purchase);
    console.log(`[purchase] ${purchaseId}: ${mode} worker ${worker.id} from ${manifest.parentSandboxId} ready ${ms} ms after the paid request, boot id ${bootId}`);
    publish({ type: "worker.forked", workerSandboxId: worker.id, parentSandboxId: manifest.parentSandboxId, ms, mode });
    return purchase;
  } catch (err) {
    await destroyWorker(worker).catch((destroyErr) => console.error(`[purchase] cleanup of ${worker.id} failed: ${errorMessage(destroyErr)}`));
    throw err;
  }
}

/** Ids of workers that belong to a purchase still in use. */
export function activePurchaseWorkerIds(): Set<string> {
  return new Set([...purchases.values()].filter((p) => p.state === "active" && !p.workerDestroyed).map((p) => p.worker.id));
}

/** Destroys the workers of every purchase, for shutdown; the gateway cannot serve done or refund once it stops. */
export async function releaseAllPurchases(): Promise<void> {
  await Promise.all([...purchases.values()].map(releaseWorker));
}

/** The PaymentIntent metadata is the audit trail tying the charge to the exact sandboxes. It never blocks delivery. */
async function recordOnPayment(offer: SignedManifest, grant: PurchaseGrant): Promise<void> {
  try {
    await tagPayment(grant.paymentIntentId, {
      offerId: grant.offerId,
      parentSandboxId: offer.manifest.parentSandboxId,
      workerSandboxId: grant.workerSandboxId,
      artifactDigest: offer.manifest.artifactDigest,
      purchaseId: grant.purchaseId,
    });
  } catch (err) {
    console.error(`[purchase] metadata update on ${grant.paymentIntentId} failed: ${errorMessage(err)}`);
  }
}

const DEFAULT_REFUND_REASON = "buyer reported a verification mismatch";

function refundReason(body: unknown): string {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : DEFAULT_REFUND_REASON;
}

export function registerPurchaseRoutes(app: Hono): void {
  app.post("/offers/:id/buy", async (c) => {
    const requestStartedAt = performance.now();
    const offer = await getOffer(c.req.param("id"));
    if (!offer) return c.json({ error: "offer not found" }, 404);

    const amountUsd = priceFor(offer.manifest.priceUsd);
    const result = await chargeCard({ amount: amountUsd, description: buyDescription(offer.manifest.name) })(c.req.raw);
    if (result.status === 402) return result.challenge;

    // The charge has settled by now; the receipt reference is the PaymentIntent id.
    const paymentIntentId = Receipt.fromResponse(await result.withReceipt(new Response(null, { status: 204 }))).reference;
    publish({ type: "payment.created", paymentIntentId, amountUsd });

    let purchase: Purchase;
    try {
      purchase = await provision(offer, paymentIntentId, requestStartedAt);
    } catch (err) {
      const reason = `worker setup failed: ${errorMessage(err)}`;
      console.error(`[purchase] ${offer.manifest.offerId}: ${reason}`);
      try {
        await refundPayment(paymentIntentId, reason);
      } catch (refundErr) {
        console.error(`[purchase] refund of ${paymentIntentId} failed: ${errorMessage(refundErr)}`);
        return c.json({ error: reason, refunded: false, paymentIntentId }, 502);
      }
      publish({ type: "payment.refunded", paymentIntentId, reason });
      return c.json({ error: reason, refunded: true, paymentIntentId }, 502);
    }

    await recordOnPayment(offer, purchase.grant);
    return result.withReceipt(Response.json(purchase.grant));
  });

  app.post("/purchases/:id/refund", async (c) => {
    const purchase = purchases.get(c.req.param("id"));
    if (!purchase) return c.json({ error: "purchase not found" }, 404);
    if (purchase.state !== "active") return c.json({ error: `purchase is ${purchase.state}, only an active purchase can be refunded` }, 409);

    const reason = await c.req.json().then(refundReason, () => DEFAULT_REFUND_REASON);
    purchase.state = "refunded";
    let refundId: string;
    try {
      refundId = await refundPayment(purchase.grant.paymentIntentId, reason);
    } catch (err) {
      purchase.state = "active";
      console.error(`[purchase] refund of ${purchase.grant.paymentIntentId} failed: ${errorMessage(err)}`);
      return c.json({ error: "Stripe refused the refund", refunded: false }, 502);
    }
    publish({ type: "payment.refunded", paymentIntentId: purchase.grant.paymentIntentId, reason });
    const workerDestroyed = await releaseWorker(purchase);
    return c.json({ refunded: true, refundId, workerDestroyed });
  });

  app.post("/purchases/:id/done", async (c) => {
    const purchase = purchases.get(c.req.param("id"));
    if (!purchase) return c.json({ error: "purchase not found" }, 404);
    if (purchase.state === "active") purchase.state = "done";
    const workerDestroyed = await releaseWorker(purchase);
    return c.json({ state: purchase.state, workerDestroyed }, workerDestroyed ? 200 : 502);
  });
}
