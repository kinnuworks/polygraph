import { writeFile } from "node:fs/promises";
import { emit, type CheckResult, type PurchaseGrant, type Receipt, type SignedManifest } from "@polygraph/core";
import type { JobResult } from "./job.js";

export function buildReceipt(
  offer: SignedManifest,
  grant: PurchaseGrant,
  job: JobResult,
  verification: CheckResult[],
  executionSandboxId?: string,
): Receipt {
  return {
    purchaseId: grant.purchaseId,
    offerId: offer.manifest.offerId,
    paymentIntentId: grant.paymentIntentId,
    artifactDigest: offer.manifest.artifactDigest,
    parentSandboxId: offer.manifest.parentSandboxId,
    workerSandboxId: grant.workerSandboxId,
    verification,
    inputSha256: job.inputSha256,
    outputSha256: job.outputSha256,
    completedAt: new Date().toISOString(),
    mode: executionSandboxId ? "buyer-owned" : "seller-worker",
    ...(executionSandboxId ? { executionSandboxId } : {}),
  };
}

/** Writes `<name>.receipt.json` beside the PDF and announces the finished job. */
export async function saveReceipt(receipt: Receipt, outputPath: string): Promise<string> {
  const path = outputPath.replace(/\.pdf$/i, "") + ".receipt.json";
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  await emit({ type: "job.completed", receipt });
  return path;
}
