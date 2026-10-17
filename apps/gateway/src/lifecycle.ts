import { config } from "./config.js";
import { revokeInspectTokens } from "./inspect.js";
import { drainPools, pooledWorkerIds, syncPools } from "./pool.js";
import { activePurchaseWorkerIds } from "./purchase.js";
import { offerParentIds } from "./offers.js";
import { destroyWorker, listLiveSandboxes } from "./sandbox.js";
import { adoptPreviousRun, trackedWorkers } from "./workers.js";

/** A worker between owners (being forked, claimed or set up) is left alone for this long. */
const HANDOVER_GRACE_MS = 3 * 60_000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function destroyAll(ids: string[], why: string): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await destroyWorker(id);
        console.log(`[sweep] destroyed ${id}: ${why}`);
      } catch (err) {
        console.error(`[sweep] destroying ${id} failed: ${errorMessage(err)}`);
      }
    }),
  );
}

/** Destroys tracked workers that neither a pool nor an active purchase holds, such as ones whose release failed. */
async function sweepOrphans(): Promise<void> {
  const held = new Set([...pooledWorkerIds(), ...activePurchaseWorkerIds()]);
  const cutoff = Date.now() - HANDOVER_GRACE_MS;
  const orphans = trackedWorkers().filter(({ id, touchedAt }) => !held.has(id) && touchedAt < cutoff);
  await destroyAll(orphans.map(({ id }) => id), "no pool or active purchase holds it");
}

/**
 * Destroys running forks of any offer's parent that this instance neither holds nor is still setting up,
 * such as the warm worker of a deployment that was put to sleep instead of stopped. Offer parents are
 * never touched.
 */
async function sweepAccountOrphans(): Promise<void> {
  if (config.orphanSweep === "off") return;
  const parents = await offerParentIds();
  if (parents.size === 0) return;
  const recentlyTouched = Date.now() - HANDOVER_GRACE_MS;
  const held = new Set([
    ...pooledWorkerIds(),
    ...activePurchaseWorkerIds(),
    ...trackedWorkers().filter(({ touchedAt }) => touchedAt >= recentlyTouched).map(({ id }) => id),
  ]);
  const oldEnough = Date.now() - config.orphanMinAgeMs;
  const orphans = (await listLiveSandboxes()).filter((sandbox) => {
    const forkedFrom = sandbox.data.forked_from;
    return (
      !!forkedFrom &&
      parents.has(forkedFrom) &&
      !parents.has(sandbox.id) &&
      !held.has(sandbox.id) &&
      Date.parse(sandbox.data.created_at) < oldEnough
    );
  });
  for (const sandbox of orphans) {
    // Gateway workers never pause (auto-pause is switched off at fork), but offer parents are paused
    // forks too. One published at runtime and not yet known to a fresh instance must survive.
    if (sandbox.status === "paused" || sandbox.status === "pausing") {
      noteOnce(sandbox.id, `[sweep] leaving ${sandbox.id} alone: a paused fork of ${sandbox.data.forked_from} may be the parent of an offer this gateway does not know`);
      continue;
    }
    const what = `${sandbox.id} (${sandbox.status}, forked from ${sandbox.data.forked_from} at ${sandbox.data.created_at})`;
    if (config.orphanSweep === "dry") {
      console.log(`[sweep] would destroy orphaned worker ${what}`);
      continue;
    }
    try {
      await destroyWorker(sandbox);
      console.log(`[sweep] destroyed orphaned worker ${what}: no pool or active purchase of this gateway holds it`);
    } catch (err) {
      console.error(`[sweep] destroying orphaned worker ${sandbox.id} failed: ${errorMessage(err)}`);
    }
  }
}

const noted = new Set<string>();

function noteOnce(key: string, line: string): void {
  if (noted.has(key)) return;
  noted.add(key);
  console.log(line);
}

let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepOrphans();
    await sweepAccountOrphans();
    await syncPools();
  } catch (err) {
    console.error(`[sweep] ${errorMessage(err)}`);
  } finally {
    sweeping = false;
  }
}

/** Cleans up after any earlier run, fills the pools, and keeps sweeping in the background. */
export function startBackgroundWork(): void {
  const leftovers = adoptPreviousRun();
  if (leftovers > 0) console.log(`[sweep] ${leftovers} worker(s) left by an earlier run will be destroyed`);
  console.log(`[sweep] account-wide orphan sweep is ${config.orphanSweep}`);
  if (config.orphanSweep === "on" && process.env.NODE_ENV !== "production") {
    console.warn("[sweep] WARNING: the orphan sweep destroys running workers of any other gateway on this CreateOS account, including a live deployment's warm workers and purchases. Use ORPHAN_SWEEP=dry to only log.");
  }
  const timer = setInterval(() => void sweep(), config.sweepIntervalMs);
  timer.unref();
  void sweep();
}

let stopping = false;

/**
 * Destroys pooled and orphaned workers and revokes live inspect tokens. Workers of active purchases stay
 * up: purchases are kept on disk, so buyers can still finish, refund or call done after a restart.
 * A second signal exits at once.
 */
export function handleShutdownSignals(stopAccepting: () => void): void {
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[gateway] ${signal}: destroying pooled workers and revoking tokens`);
    stopAccepting();
    await Promise.allSettled([drainPools(), revokeInspectTokens()]);
    await sweepRemaining();
    process.exit(0);
  };
  process.on("SIGINT", (signal) => void stop(signal));
  process.on("SIGTERM", (signal) => void stop(signal));
}

/** Anything still tracked that no active purchase holds, such as a fork that was still starting. */
async function sweepRemaining(): Promise<void> {
  const kept = activePurchaseWorkerIds();
  const remaining = trackedWorkers().map(({ id }) => id).filter((id) => !kept.has(id));
  if (remaining.length > 0) await destroyAll(remaining, "gateway shutting down");
}
