import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { Receipt } from "mppx";
import type { Sandbox } from "@nodeops-createos/sandbox";
import type { PurchaseGrant, SignedManifest } from "@polygraph/core";
import { config } from "./config.js";
import { publish } from "./events.js";
import { getOffer } from "./offers.js";
import { chargeCard, priceFor, refundPayment, tagPayment } from "./payments.js";
import { destroyWorker, forkWorker, mintAccessToken, reseedWorker } from "./sandbox.js";

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

/** Forks, reseeds and hands out a scoped token. Any failure destroys the worker before rethrowing. */
async function provision(offer: SignedManifest, paymentIntentId: string): Promise<Purchase> {
  const { manifest } = offer;
  const { worker, ms } = await forkWorker(manifest.parentSandboxId);
  publish({ type: "worker.forked", workerSandboxId: worker.id, parentSandboxId: manifest.parentSandboxId, ms });
  try {
    const { bootId } = await reseedWorker(worker);
    const workerToken = await mintAccessToken(worker.id);
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
    console.log(`[purchase] ${purchaseId}: worker ${worker.id} forked from ${manifest.parentSandboxId} in ${ms} ms, boot id ${bootId}`);
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
    return purchase;
  } catch (err) {
    await destroyWorker(worker).then(
      () => publish({ type: "worker.destroyed", workerSandboxId: worker.id }),
      (destroyErr) => console.error(`[purchase] cleanup of ${worker.id} failed: ${errorMessage(destroyErr)}`),
    );
    throw err;
  }
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
      purchase = await provision(offer, paymentIntentId);
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
