import { access } from "node:fs/promises";
import { basename } from "node:path";
import { emit, type PurchaseGrant, type SignedManifest } from "@polygraph/core";
import { discover } from "./discover.js";
import { postJson } from "./http.js";
import { runJob } from "./job.js";
import { buyOffer, PaymentDeclined, type PayMode, type Payment } from "./pay.js";
import { buildReceipt, saveReceipt } from "./receipt.js";
import { printCheck, printRefusal, printSummary, type OfferRow, type Outcome } from "./summary.js";
import { verifyOffer, verifyWorker, type Verdict } from "./verify.js";

export interface RunOptions {
  gateway: string;
  file: string;
  pay: PayMode;
  outDir: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Turns an unexpected error during verification into a failed verdict, so it can never lead to a payment or an upload. */
async function safely(offerId: string, verify: () => Promise<Verdict>): Promise<Verdict> {
  try {
    return await verify();
  } catch (err) {
    const check = { id: "verification-error", label: "Verification could not finish", status: "fail" as const, detail: errorText(err) };
    await emit({ type: "buyer.check", offerId, check });
    printCheck(check);
    return { passed: false, checks: [check], reason: `${check.label}: ${check.detail}` };
  }
}

async function refuse(offerId: string, reason: string): Promise<void> {
  await emit({ type: "buyer.refused", offerId, reason });
  printRefusal(offerId, reason);
}

async function tellGateway(gateway: string, grant: PurchaseGrant, action: "refund" | "done", reason?: string): Promise<void> {
  try {
    await postJson(`${gateway}/purchases/${encodeURIComponent(grant.purchaseId)}/${action}`, reason ? { reason } : {});
    await emit({ type: "buyer.step", step: action === "refund" ? "refund-requested" : "released", detail: `${grant.purchaseId}${reason ? ` · ${reason}` : ""}` });
  } catch (err) {
    await emit({ type: "buyer.step", step: `${action}-failed`, detail: `${grant.purchaseId} · ${errorText(err)}` });
  }
}

/**
 * Discovers offers, verifies each one against CreateOS (cheapest first), pays for the first that
 * holds up, verifies the worker it receives, runs the job there and keeps a receipt.
 * Returns true when a job completed.
 */
export async function run(options: RunOptions): Promise<boolean> {
  const { gateway } = options;
  await access(options.file);
  await emit({ type: "buyer.step", step: "start", detail: `${basename(options.file)} · gateway ${gateway} · pay ${options.pay}` });

  const { offers } = await discover(gateway);
  const rows: OfferRow[] = [];
  const job: [string, string][] = [];
  const row = (offer: SignedManifest, outcome: Outcome, evidence = "") =>
    rows.push({ offerId: offer.manifest.offerId, priceUsd: offer.manifest.priceUsd, outcome, evidence });

  for (const offer of offers) {
    const { offerId } = offer.manifest;
    if (job.length > 0) {
      row(offer, "not needed");
      continue;
    }

    const before = await safely(offerId, () => verifyOffer(gateway, offer));
    if (!before.passed) {
      const reason = before.reason ?? "verification failed";
      await refuse(offerId, reason);
      row(offer, "refused before payment", reason);
      continue;
    }

    let payment: Payment;
    try {
      payment = await buyOffer(gateway, offer.manifest, options.pay);
    } catch (err) {
      if (err instanceof PaymentDeclined) {
        await refuse(offerId, err.message);
        row(offer, "payment declined", err.message);
      } else {
        await emit({ type: "buyer.step", step: "payment-failed", detail: `${offerId} · ${errorText(err)}` });
        row(offer, "failed", errorText(err));
      }
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
      const result = await runJob(grant, options.file, options.outDir);
      const verification = [...before.checks, ...after.checks, ...result.checks];
      const receipt = buildReceipt(offer, grant, result, verification);
      const receiptPath = await saveReceipt(receipt, result.outputPath);
      await tellGateway(gateway, grant, "done");
      row(offer, "completed", `${verification.length} checks passed`);
      job.push(
        ["purchase", grant.purchaseId],
        ["payment", `${grant.paymentIntentId} · $${payment.amountUsd}`],
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
