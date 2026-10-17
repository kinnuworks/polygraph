import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * Every worker the gateway has forked and not yet destroyed, with the last time something claimed it.
 * Mirrored to a file so workers left by a crashed process are found and destroyed on the next start.
 */
const tracked = new Map<string, number>();

function persist(): void {
  try {
    mkdirSync(dirname(config.ledgerPath), { recursive: true });
    writeFileSync(config.ledgerPath, JSON.stringify([...tracked.keys()]));
  } catch (err) {
    console.error(`[workers] could not write ${config.ledgerPath}: ${(err as Error).message}`);
  }
}

/** Takes over the workers a previous run recorded, marked as long untouched so the next sweep destroys them. */
export function adoptPreviousRun(): number {
  let ids: unknown;
  try {
    ids = JSON.parse(readFileSync(config.ledgerPath, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(ids)) return 0;
  for (const id of ids) if (typeof id === "string") tracked.set(id, 0);
  return tracked.size;
}

export function trackWorker(id: string): void {
  tracked.set(id, Date.now());
  persist();
}

/** Marks a worker as just handed over, so the sweep leaves it alone while its new owner sets it up. */
export function touchWorker(id: string): void {
  if (tracked.has(id)) tracked.set(id, Date.now());
}

export function forgetWorker(id: string): void {
  if (tracked.delete(id)) persist();
}

export function trackedWorkers(): Array<{ id: string; touchedAt: number }> {
  return [...tracked].map(([id, touchedAt]) => ({ id, touchedAt }));
}
