import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { emit, type PurchaseGrant, type SignedManifest } from "@polygraph/core";
import { discover } from "./discover.js";
import { runJob, type JobResult } from "./job.js";
import { runOwned } from "./own.js";
import { buyOffer, PaidRequestFailed, PaymentDeclined, type PayMode, type Payment } from "./pay.js";
import { buildReceipt, saveReceipt } from "./receipt.js";
import { SellerPins } from "./pins.js";
import { tellGateway } from "./purchases.js";
import { printSummary, type OfferRow, type Outcome } from "./summary.js";
import { RemoteSandbox } from "./worker.js";
import { verifyOffer, verifyWorker, type Verdict, type WorkerVerdict } from "./verify.js";

/** worker: run in the seller's verified worker. own: run in a sandbox on the buyer's own account. */
export type RunMode = "worker" | "own";

export interface RunOptions {
  gateway: string;
  file: string;
  pay: PayMode;
  mode: RunMode;
  outDir: string;
  /** Pin the seller key seen now if none is pinned for this gateway yet. */
  trustSeller: boolean;
}

/** Seller keys pinned with --trust-seller, one per gateway origin. */
const PINS_FILE = resolve("data/buyer/trusted-sellers.json");

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Turns an unexpected error during verification into a failed verdict, so it can never lead to a payment or an upload. */
async function safely(offerId: string, verify: () => Promise<WorkerVerdict>): Promise<WorkerVerdict> {
  try {
    return await verify();
  } catch (err) {
    const check = { id: "verification-error", label: "Verification could not finish", status: "fail" as const, detail: errorText(err) };
    await emit({ type: "buyer.check", offerId, check });
    return { passed: false, checks: [check], reason: `${check.label}: ${check.detail}` };
  }
}

async function refuse(offerId: string, reason: string): Promise<void> {
  await emit({ type: "buyer.refused", offerId, reason });
}


/**
 * Discovers offers, verifies each one against CreateOS (cheapest first), pays for the first that
 * holds up, verifies the worker it receives, runs the job there and keeps a receipt.
 * Returns true when a job completed.
 */
export async function run(options: RunOptions): Promise<boolean> {
  const { gateway } = options;
  await access(options.file);
  await emit({ type: "buyer.step", step: "start", detail: `${basename(options.file)} · gateway ${gateway} · pay ${options.pay} · mode ${options.mode}` });
  const pins = await SellerPins.load(PINS_FILE, options.trustSeller);

  const { offers } = await discover(gateway);
  const rows: OfferRow[] = [];
  const job: [string, string][] = [];
  const row = (offer: SignedManifest, outcome: Outcome, evidence = "") =>
    rows.push({ offerId: offer.manifest.offerId, priceUsd: offer.manifest.priceUsd, outcome, evidence });

  // Check every offer against the platform before paying anyone, so every refusal is on the record.
  const candidates: { offer: SignedManifest; before: Verdict }[] = [];
  for (const offer of offers) {
    const { offerId } = offer.manifest;
    const before = await safely(offerId, () => verifyOffer(gateway, offer, pins));
    if (before.passed) {
      candidates.push({ offer, before });
      continue;
    }
    const reason = before.reason ?? "verification failed";
    await refuse(offerId, reason);
    row(offer, "refused before payment", reason);
  }

  for (const { offer, before } of candidates) {
    const { offerId } = offer.manifest;
    if (job.length > 0) {
      row(offer, "not needed");
      continue;
    }

    let payment: Payment;
    try {
      payment = await buyOffer(gateway, offer.manifest, options.pay);
    } catch (err) {
      if (err instanceof PaymentDeclined) {
        await refuse(offerId, err.message);
        row(offer, "payment declined", err.message);
        continue;
      }
      await emit({ type: "buyer.step", step: "payment-failed", detail: `${offerId} · ${errorText(err)}` });
      row(offer, "failed", errorText(err));
      // After a paid request fails, paying the next seller could charge twice; stop and let the refund settle.
      if (err instanceof PaidRequestFailed) break;
      continue;
    }
    const { grant } = payment;

    const after = await safely(offerId, () => verifyWorker(offer, grant, payment.receiptReference));
    if (!after.passed) {
      const reason = after.reason ?? "worker verification failed";
      await refuse(offerId, `after payment, document withheld: ${reason}`);
      await tellGateway(gateway, grant, "refund", reason);
      row(offer, "refunded", reason);
      continue;
    }

    try {
      let result: JobResult;
      let verification = [...before.checks, ...after.checks];
      let executionSandboxId: string | undefined;
      if (options.mode === "own") {
        if (!after.bundle) throw new Error("the verified tool bundle is missing");
        const owned = await runOwned(offer, after.bundle, options.file, options.outDir);
        result = owned.job;
        executionSandboxId = owned.sandboxId;
        verification = [...verification, ...owned.checks];
      } else {
        result = await runJob(new RemoteSandbox(grant.workerSandboxId, grant.workerToken), offerId, options.file, options.outDir);
        verification = [...verification, ...result.checks];
      }
      const receipt = buildReceipt(offer, grant, result, verification, executionSandboxId);
      const receiptPath = await saveReceipt(receipt, result.outputPath);
      await tellGateway(gateway, grant, "done");
      row(offer, "completed", `${verification.length} checks passed`);
      job.push(
        ["purchase", grant.purchaseId],
        ["payment", `${grant.paymentIntentId} · $${payment.amountUsd}`],
        ["mode", executionSandboxId ? `buyer-owned · ran in ${executionSandboxId} (destroyed), seller worker got nothing` : "seller worker"],
        ["parent sandbox", offer.manifest.parentSandboxId],
        ["worker sandbox", grant.workerSandboxId],
        ["artifact digest", offer.manifest.artifactDigest],
        ["input sha256", result.inputSha256],
        ["output sha256", result.outputSha256],
        ["pdf", `${result.pages} pages · ${result.outputBytes} bytes · converted in ${result.convertMs} ms`],
        ["output", result.outputPath],
        ["receipt", receiptPath],
      );
    } catch (err) {
      // The worker passed every check, so a failure here is the tool's; ask for the money back and stop.
      await emit({ type: "buyer.step", step: "job-failed", detail: `${offerId} · ${errorText(err)}` });
      await tellGateway(gateway, grant, "refund", `job failed: ${errorText(err)}`);
      row(offer, "failed", errorText(err));
      break;
    }
  }

  if (offers.length === 0) await emit({ type: "buyer.step", step: "no-offers", detail: `${gateway}/offers listed nothing usable` });
  if (job.length === 0 && offers.length > 0) await emit({ type: "buyer.step", step: "no-purchase", detail: "no offer passed verification and delivered" });
  printSummary({ offers: rows, job });
  return job.length > 0;
}
