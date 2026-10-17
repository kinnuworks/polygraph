import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { WorkerClaims } from "./verification.js";

export type PurchaseState = "active" | "refunded" | "done" | "expired";

/** What the gateway keeps about a sale. The purchase secret is stored only as a hash; the worker token is not stored. */
export interface PurchaseRecord {
  purchaseId: string;
  offerId: string;
  paymentIntentId: string;
  workerSandboxId: string;
  claims: WorkerClaims;
  secretSha256: string;
  state: PurchaseState;
  workerDestroyed: boolean;
  createdAt: string;
  expiresAt: string;
}

/** Finished purchases are dropped from the file after this long. */
const RETAIN_FINISHED_MS = 24 * 60 * 60_000;

const records = new Map<string, PurchaseRecord>();

function load(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(config.purchasesPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[purchases] could not read ${config.purchasesPath}: ${(err as Error).message}`);
    return;
  }
  if (!Array.isArray(parsed)) return;
  for (const record of parsed as PurchaseRecord[]) {
    if (typeof record?.purchaseId === "string" && typeof record.workerSandboxId === "string") records.set(record.purchaseId, record);
  }
  if (records.size > 0) console.log(`[purchases] restored ${records.size} purchase(s) from ${config.purchasesPath}`);
}

/** Writes through a temporary file so a crash mid-write never leaves a truncated file. */
function save(): void {
  const cutoff = Date.now() - RETAIN_FINISHED_MS;
  for (const [id, record] of records) {
    if (record.state !== "active" && Date.parse(record.expiresAt) < cutoff) records.delete(id);
  }
  try {
    mkdirSync(dirname(config.purchasesPath), { recursive: true });
    const temp = `${config.purchasesPath}.tmp`;
    writeFileSync(temp, JSON.stringify([...records.values()], null, 1), { mode: 0o600 });
    renameSync(temp, config.purchasesPath);
  } catch (err) {
    console.error(`[purchases] could not write ${config.purchasesPath}: ${(err as Error).message}`);
  }
}

load();

export const getPurchase = (purchaseId: string): PurchaseRecord | undefined => records.get(purchaseId);

export const allPurchases = (): PurchaseRecord[] => [...records.values()];

export function addPurchase(record: PurchaseRecord): void {
  records.set(record.purchaseId, record);
  save();
}

export function updatePurchase(record: PurchaseRecord, changes: Partial<Pick<PurchaseRecord, "state" | "workerDestroyed">>): void {
  Object.assign(record, changes);
  save();
}
