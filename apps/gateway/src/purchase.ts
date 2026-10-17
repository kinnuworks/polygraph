import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { Receipt } from "mppx";
import { CreateosSandboxTimeoutError, type Sandbox } from "@nodeops-createos/sandbox";
import type { PurchaseGrant, SignedManifest } from "@polygraph/core";
import { config } from "./config.js";
import { publish } from "./events.js";
import { getOffer } from "./offers.js";
import { chargeCard, refundPayment, tagPayment } from "./payments.js";
import { claimWarmWorker, keepSlowFork, noteCapacityLimit, yieldPooledWorker } from "./pool.js";
import { addPurchase, allPurchases, getPurchase, updatePurchase, type PurchaseRecord } from "./purchase-store.js";
import { destroyWorker, finishFork, isCapacityError, issueAccessToken, reseedWorker, startFork } from "./sandbox.js";
import { auditWorker, jobInputPresent } from "./verification.js";

/** Header that carries the purchase secret from the grant. */
export const PURCHASE_SECRET_HEADER = "x-purchase-secret";

const expiryTimers = new Map<string, NodeJS.Timeout>();
const unusedTimers = new Map<string, NodeJS.Timeout>();
/** Purchases with a refund or done request under way, so two requests cannot act on one purchase at once. */
const busy = new Set<string>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const secretHash = (secret: string) => createHash("sha256").update(secret).digest();

function buyDescription(offerName: string): string {
  return `${offerName}: one job in a fresh worker forked from the offer's verified parent sandbox`;
}

/** Destroys the purchase's worker once; later calls are no-ops. */
async function releaseWorker(purchase: PurchaseRecord): Promise<boolean> {
  for (const timers of [expiryTimers, unusedTimers]) {
    clearTimeout(timers.get(purchase.purchaseId));
    timers.delete(purchase.purchaseId);
  }
  if (purchase.workerDestroyed) return true;
  try {
    await destroyWorker(purchase.workerSandboxId);
  } catch (err) {
    console.error(`[purchase] destroying ${purchase.workerSandboxId} failed: ${errorMessage(err)}`);
    return false;
  }
  updatePurchase(purchase, { workerDestroyed: true });
  publish({ type: "worker.destroyed", workerSandboxId: purchase.workerSandboxId });
  return true;
}

function scheduleExpiry(purchase: PurchaseRecord): void {
  const timer = setTimeout(() => {
    if (purchase.state === "active") updatePurchase(purchase, { state: "expired" });
    void releaseWorker(purchase);
  }, Math.max(0, Date.parse(purchase.expiresAt) - Date.now()));
  timer.unref();
  expiryTimers.set(purchase.purchaseId, timer);
}

const UNUSED_REASON = "expired unused: buyer never received or used the worker";

/**
 * A buyer whose paid request timed out at the proxy never got the grant, so cannot ask for a refund.
 * Once the unused window passes, a worker with no job input is refunded and destroyed; one that ran a
 * job is left to the normal expiry. A failed check is retried once, then the buyer gets the benefit of the doubt.
 */
function scheduleUnusedCheck(purchase: PurchaseRecord, delayMs: number, attempt = 1): void {
  const timer = setTimeout(() => void checkUnused(purchase, attempt), Math.max(0, delayMs));
  timer.unref();
  unusedTimers.set(purchase.purchaseId, timer);
}

async function checkUnused(purchase: PurchaseRecord, attempt: number): Promise<void> {
  unusedTimers.delete(purchase.purchaseId);
  if (purchase.state !== "active" || purchase.workerDestroyed) return;
  if (busy.has(purchase.purchaseId)) return scheduleUnusedCheck(purchase, 30_000, attempt);
  busy.add(purchase.purchaseId);
  try {
    let reason = UNUSED_REASON;
    try {
      if (await jobInputPresent(purchase.workerSandboxId)) {
        console.log(`[purchase] ${purchase.purchaseId}: job input found, left to run until ${purchase.expiresAt}`);
        return;
      }
    } catch (err) {
      if (attempt < 2) {
        console.warn(`[purchase] ${purchase.purchaseId}: could not check for job input (${errorMessage(err)}); retrying in 60 s`);
        return scheduleUnusedCheck(purchase, 60_000, attempt + 1);
      }
      reason = `${UNUSED_REASON} (the worker could not be inspected: ${errorMessage(err)})`;
    }
    try {
      await refundPayment(purchase.paymentIntentId, reason);
    } catch (err) {
      console.error(`[purchase] !!! auto-refund of ${purchase.paymentIntentId} failed: ${errorMessage(err)}`);
      return;
    }
    updatePurchase(purchase, { state: "refunded" });
    console.log(`[purchase] ${purchase.purchaseId}: refunded ${purchase.paymentIntentId}, ${reason}`);
    publish({ type: "payment.refunded", paymentIntentId: purchase.paymentIntentId, reason });
    await releaseWorker(purchase);
  } finally {
    busy.delete(purchase.purchaseId);
  }
}

function scheduleLifecycle(purchase: PurchaseRecord): void {
  scheduleExpiry(purchase);
  if (purchase.state === "active") scheduleUnusedCheck(purchase, Date.parse(purchase.createdAt) + config.unusedRefundMs - Date.now());
}

// Purchases restored from disk keep their deadlines; ones that lapsed while the gateway was down are handled now.
for (const purchase of allPurchases()) {
  if (!purchase.workerDestroyed) scheduleLifecycle(purchase);
}

/** The sale's cold fork did not start in time; it was refunded and the fork is kept for a retry. */
class SlowForkError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("the worker did not start in time");
  }
}

/** Starts a cold fork. If the account quota refuses it, an idle pooled worker of another offer gives up its slot once. */
async function startColdFork(offer: SignedManifest): Promise<Sandbox> {
  const { parentSandboxId, offerId } = offer.manifest;
  try {
    return await startFork(parentSandboxId);
  } catch (err) {
    if (!isCapacityError(err)) throw err;
    noteCapacityLimit(`sale of ${offerId} hit the CreateOS quota (${errorMessage(err)})`);
    if (!(await yieldPooledWorker(offerId))) throw err;
    return startFork(parentSandboxId);
  }
}

/**
 * Takes a pooled worker when one is ready, otherwise forks one now. A cold fork gets until `deadline`
 * to start, so the paid request answers before the hosting proxy cuts it; a fork that misses it is kept
 * for the buyer's retry and the sale fails with SlowForkError.
 */
async function obtainWorker(offer: SignedManifest, deadline: number): Promise<{ worker: Sandbox; mode: "warm" | "cold" }> {
  const warm = await claimWarmWorker(offer);
  if (warm) return { worker: warm, mode: "warm" };
  const worker = await startColdFork(offer);
  const forkStarted = Date.now();
  try {
    await worker.waitUntilRunning({ timeoutMs: Math.max(deadline - Date.now(), 1_000) });
  } catch (err) {
    if (!(err instanceof CreateosSandboxTimeoutError)) {
      await destroyWorker(worker).catch(() => undefined);
      throw err;
    }
    const waited = Date.now() - forkStarted;
    keepSlowFork(offer, worker, config.forkReadyTimeoutMs - waited);
    throw new SlowForkError(30);
  }
  return { worker: await finishFork(worker, 10_000), mode: "cold" };
}

/**
 * Gets a worker, reseeds it and hands out a scoped token. Reseeding happens here, at sale time, so a
 * pooled worker never shares random state with the others. Any failure destroys the worker before rethrowing.
 */
async function provision(offer: SignedManifest, paymentIntentId: string, requestStartedAt: number): Promise<PurchaseGrant> {
  const { manifest } = offer;
  const deadline = Date.now() - (performance.now() - requestStartedAt) + config.buyForkDeadlineMs;
  const { worker, mode } = await obtainWorker(offer, deadline);
  try {
    const { bootId } = await reseedWorker(worker);
    const workerToken = await issueAccessToken(worker.id);
    const ms = Math.round(performance.now() - requestStartedAt);
    const purchaseSecret = randomBytes(32).toString("base64url");
    const grant: PurchaseGrant = {
      purchaseId: `pur_${randomUUID()}`,
      offerId: manifest.offerId,
      workerSandboxId: worker.id,
      workerToken,
      platformUrl: config.createos.baseUrl,
      paymentIntentId,
      expiresAt: new Date(Date.now() + config.purchaseTtlMs).toISOString(),
      purchaseSecret,
    };
    const record: PurchaseRecord = {
      purchaseId: grant.purchaseId,
      offerId: grant.offerId,
      paymentIntentId,
      workerSandboxId: worker.id,
      claims: { parentSandboxId: manifest.parentSandboxId, egress: manifest.egress, artifactDigest: manifest.artifactDigest },
      secretSha256: secretHash(purchaseSecret).toString("hex"),
      state: "active",
      workerDestroyed: false,
      createdAt: new Date().toISOString(),
      expiresAt: grant.expiresAt,
    };
    addPurchase(record);
    scheduleLifecycle(record);
    console.log(`[purchase] ${grant.purchaseId}: ${mode} worker ${worker.id} from ${manifest.parentSandboxId} ready ${ms} ms after the paid request, boot id ${bootId}`);
    publish({ type: "worker.forked", workerSandboxId: worker.id, parentSandboxId: manifest.parentSandboxId, ms, mode });
    return grant;
  } catch (err) {
    await destroyWorker(worker).catch((destroyErr) => console.error(`[purchase] cleanup of ${worker.id} failed: ${errorMessage(destroyErr)}`));
    throw err;
  }
}

/** Ids of workers that belong to a purchase still in use. */
export function activePurchaseWorkerIds(): Set<string> {
  return new Set(allPurchases().filter((p) => p.state === "active" && !p.workerDestroyed).map((p) => p.workerSandboxId));
}

/** The PaymentIntent metadata is the audit trail tying the charge to the exact sandboxes. It never blocks delivery. */
async function recordOnPayment(grant: PurchaseGrant, offer: SignedManifest): Promise<void> {
  try {
    await tagPayment(grant.paymentIntentId, {
      offerId: grant.offerId,
      parentSandboxId: offer.manifest.parentSandboxId,
      workerSandboxId: grant.workerSandboxId,
      artifactDigest: offer.manifest.artifactDigest,
      purchaseId: grant.purchaseId,
    });
  } catch (err) {
    console.error(
      `[purchase] !!! PaymentIntent ${grant.paymentIntentId} has NO Polygraph metadata after retries; ` +
        `purchase ${grant.purchaseId}, worker ${grant.workerSandboxId}: ${errorMessage(err)}`,
    );
  }
}

/** Finds the purchase and checks the caller's secret. Returns the purchase or the response to send. */
function authorize(c: Context): PurchaseRecord | Response {
  const purchase = getPurchase(c.req.param("id") ?? "");
  if (!purchase) return c.json({ error: "purchase not found" }, 404);
  const presented = c.req.header(PURCHASE_SECRET_HEADER);
  if (!presented || !timingSafeEqual(secretHash(presented), Buffer.from(purchase.secretSha256, "hex"))) {
    return c.json({ error: `missing or wrong ${PURCHASE_SECRET_HEADER} header` }, 401);
  }
  return purchase;
}

async function buyerNote(c: Context): Promise<string> {
  const body: unknown = await c.req.json().catch(() => null);
  const reason = (body as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason.trim().slice(0, 200) : "";
}

export function registerPurchaseRoutes(app: Hono): void {
  app.post("/offers/:id/buy", async (c) => {
    const requestStartedAt = performance.now();
    const offer = await getOffer(c.req.param("id"));
    if (!offer) return c.json({ error: "offer not found" }, 404);

    const amountUsd = offer.manifest.priceUsd;
    const result = await chargeCard({ amount: amountUsd, description: buyDescription(offer.manifest.name) })(c.req.raw);
    if (result.status === 402) return result.challenge;

    // The charge has settled by now; the receipt reference is the PaymentIntent id.
    const paymentIntentId = Receipt.fromResponse(await result.withReceipt(new Response(null, { status: 204 }))).reference;
    publish({ type: "payment.created", paymentIntentId, amountUsd });

    let grant: PurchaseGrant;
    try {
      grant = await provision(offer, paymentIntentId, requestStartedAt);
    } catch (err) {
      const slow = err instanceof SlowForkError;
      const reason = slow
        ? `worker did not start within ${config.buyForkDeadlineMs / 1000} s; it is kept warm for a retry`
        : `worker setup failed: ${errorMessage(err)}`;
      console.error(`[purchase] ${offer.manifest.offerId}: ${reason}`);
      try {
        await refundPayment(paymentIntentId, reason);
      } catch (refundErr) {
        console.error(`[purchase] !!! refund of ${paymentIntentId} failed: ${errorMessage(refundErr)}`);
        return c.json({ error: reason, refunded: false, paymentIntentId }, 502);
      }
      publish({ type: "payment.refunded", paymentIntentId, reason });
      if (slow) {
        c.header("Retry-After", String(err.retryAfterSeconds));
        return c.json({ error: reason, refunded: true, paymentIntentId, retryAfter: err.retryAfterSeconds }, 503);
      }
      return c.json({ error: reason, refunded: true, paymentIntentId }, 502);
    }

    await recordOnPayment(grant, offer);
    return result.withReceipt(Response.json(grant));
  });

  /**
   * A refund has to be earned: the gateway re-checks the worker itself and refunds only when a signed
   * claim is false and no job has started. The buyer's word alone is not enough.
   */
  app.post("/purchases/:id/refund", async (c) => {
    const purchase = authorize(c);
    if (purchase instanceof Response) return purchase;
    if (purchase.state !== "active") return c.json({ refunded: false, error: `purchase is ${purchase.state}, only an active purchase can be refunded` }, 409);
    if (busy.has(purchase.purchaseId)) return c.json({ refunded: false, error: "another request for this purchase is under way" }, 409);

    busy.add(purchase.purchaseId);
    try {
      const note = await buyerNote(c);
      let audit;
      try {
        audit = await auditWorker(purchase.workerSandboxId, purchase.claims);
      } catch (err) {
        console.error(`[purchase] audit of ${purchase.workerSandboxId} failed: ${errorMessage(err)}`);
        return c.json({ refunded: false, error: "the gateway could not check the worker on CreateOS; try again" }, 502);
      }
      const { checks } = audit;
      if (audit.jobStarted) return c.json({ refunded: false, error: "a job has already started in this worker", checks }, 409);
      if (!audit.claimFailed) return c.json({ refunded: false, error: "every claim checked out, so there is nothing to refund", checks }, 409);

      const failed = checks.filter((check) => check.status === "fail").map((check) => `${check.label}: ${check.detail}`);
      const reason = `gateway check failed: ${failed.join("; ")}${note ? ` (buyer: ${note})` : ""}`;
      let refundId: string;
      try {
        refundId = await refundPayment(purchase.paymentIntentId, reason);
      } catch (err) {
        console.error(`[purchase] refund of ${purchase.paymentIntentId} failed: ${errorMessage(err)}`);
        return c.json({ refunded: false, error: "Stripe refused the refund", checks }, 502);
      }
      updatePurchase(purchase, { state: "refunded" });
      publish({ type: "payment.refunded", paymentIntentId: purchase.paymentIntentId, reason });
      const workerDestroyed = await releaseWorker(purchase);
      return c.json({ refunded: true, refundId, workerDestroyed, checks });
    } finally {
      busy.delete(purchase.purchaseId);
    }
  });

  app.post("/purchases/:id/done", async (c) => {
    const purchase = authorize(c);
    if (purchase instanceof Response) return purchase;
    if (busy.has(purchase.purchaseId)) return c.json({ error: "another request for this purchase is under way" }, 409);
    busy.add(purchase.purchaseId);
    try {
      if (purchase.state === "active") updatePurchase(purchase, { state: "done" });
      const workerDestroyed = await releaseWorker(purchase);
      return c.json({ state: purchase.state, workerDestroyed }, workerDestroyed ? 200 : 502);
    } finally {
      busy.delete(purchase.purchaseId);
    }
  });
}
