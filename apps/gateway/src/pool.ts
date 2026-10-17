import type { Sandbox } from "@nodeops-createos/sandbox";
import type { SignedManifest } from "@polygraph/core";
import { config } from "./config.js";
import { listOffers } from "./offers.js";
import { destroyWorker, forkWorker, isCapacityError, isRunning } from "./sandbox.js";
import { touchWorker } from "./workers.js";

/** Pre-forked, running workers for one offer. Keyed by offer and parent, since a republished offer may point at a new parent. */
interface Pool {
  offerId: string;
  parentSandboxId: string;
  ready: Sandbox[];
  filling: number;
}

const pools = new Map<string, Pool>();
const inFlight = new Set<Promise<void>>();
let forkingBlockedUntil = 0;
let draining = false;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function discard(worker: Sandbox, why: string, untilGone = false): Promise<void> {
  console.log(`[pool] destroying ${worker.id}: ${why}`);
  return destroyWorker(worker, { untilGone }).catch((err) => console.error(`[pool] destroying ${worker.id} failed: ${errorMessage(err)}`));
}

async function forkOne(pool: Pool): Promise<void> {
  pool.filling++;
  try {
    const started = performance.now();
    const worker = await forkWorker(pool.parentSandboxId);
    if (draining || pools.get(pool.offerId) !== pool) return discard(worker, "pool closed while it was forking");
    pool.ready.push(worker);
    console.log(`[pool] ${pool.offerId}: warm worker ${worker.id} ready in ${Math.round(performance.now() - started)} ms (${pool.ready.length}/${config.poolSize})`);
  } catch (err) {
    if (isCapacityError(err)) {
      noteCapacityLimit(`${pool.offerId}: CreateOS refused a fork (${errorMessage(err)})`);
    } else {
      console.error(`[pool] ${pool.offerId}: fork from ${pool.parentSandboxId} failed: ${errorMessage(err)}`);
    }
  } finally {
    pool.filling--;
  }
}

/** Stops pool forks for a while, so the account quota is left for sales that fork on demand. */
export function noteCapacityLimit(reason: string): void {
  if (Date.now() >= forkingBlockedUntil) console.warn(`[pool] ${reason}; pools pause for ${config.forkBackoffMs / 1000} s and sales fork on demand`);
  forkingBlockedUntil = Date.now() + config.forkBackoffMs;
}

/** Starts forks in the background until the pool is full. Failures are logged and retried on the next sweep. */
function refill(pool: Pool): void {
  if (draining) return;
  while (pool.ready.length + pool.filling < config.poolSize && Date.now() >= forkingBlockedUntil) {
    const fork = forkOne(pool);
    inFlight.add(fork);
    void fork.finally(() => inFlight.delete(fork));
  }
}

function closePool(pool: Pool, why: string): void {
  pools.delete(pool.offerId);
  for (const worker of pool.ready.splice(0)) void discard(worker, why);
}

/** Hands out a running pooled worker for this offer, or null when none is ready. */
export async function claimWarmWorker(offer: SignedManifest): Promise<Sandbox | null> {
  const pool = pools.get(offer.manifest.offerId);
  if (!pool || pool.parentSandboxId !== offer.manifest.parentSandboxId) return null;
  for (let worker = pool.ready.shift(); worker; worker = pool.ready.shift()) {
    touchWorker(worker.id);
    if (await isRunning(worker).catch(() => false)) {
      refill(pool);
      return worker;
    }
    // Wait until its quota slot is free, since the sale forks on demand next.
    await discard(worker, `found ${worker.status} at claim time`, true);
  }
  // No refill on a miss: the sale is about to fork on demand and should not race a pool fork for quota.
  return null;
}

/**
 * Destroys one idle pooled worker of another offer and waits until CreateOS has freed its slot,
 * so a sale that hit the quota can fork. Returns false when no pooled worker was available.
 */
export async function yieldPooledWorker(exceptOfferId: string): Promise<boolean> {
  const pool = [...pools.values()].find((p) => p.offerId !== exceptOfferId && p.ready.length > 0);
  const worker = pool?.ready.shift();
  if (!worker) return false;
  console.log(`[pool] destroying ${worker.id} from ${pool!.offerId} to free quota for a sale`);
  await destroyWorker(worker, { untilGone: true });
  return true;
}

/** Ids of workers waiting in a pool. */
export function pooledWorkerIds(): Set<string> {
  return new Set([...pools.values()].flatMap((pool) => pool.ready.map((worker) => worker.id)));
}

/** Matches pools to the offers on disk, drops workers that stopped running, and tops every pool up. */
export async function syncPools(): Promise<void> {
  if (draining) return;
  const offers = (await listOffers()).filter(
    (offer) => config.poolOffers.size === 0 || config.poolOffers.has(offer.manifest.offerId),
  );
  const current = new Map(offers.map((offer) => [offer.manifest.offerId, offer.manifest.parentSandboxId]));

  for (const pool of [...pools.values()]) {
    const parent = current.get(pool.offerId);
    if (parent === undefined) closePool(pool, `offer ${pool.offerId} is no longer published`);
    else if (parent !== pool.parentSandboxId) closePool(pool, `offer ${pool.offerId} now forks from ${parent}`);
  }

  for (const [offerId, parentSandboxId] of current) {
    let pool = pools.get(offerId);
    if (!pool) {
      pool = { offerId, parentSandboxId, ready: [], filling: 0 };
      pools.set(offerId, pool);
    }
    const checked = await Promise.all(pool.ready.map(async (worker) => ({ worker, running: await isRunning(worker).catch(() => true) })));
    for (const { worker, running } of checked) {
      const index = pool.ready.indexOf(worker);
      if (running || index === -1) continue;
      pool.ready.splice(index, 1);
      void discard(worker, `stopped running (${worker.status})`);
    }
    refill(pool);
  }
}

/** Longest a shutdown waits for forks already under way; anything still forking is destroyed by id afterwards. */
const DRAIN_WAIT_MS = 15_000;

/** Stops refilling, briefly waits for forks under way, and destroys every pooled worker. */
export async function drainPools(): Promise<void> {
  draining = true;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, DRAIN_WAIT_MS)));
  await Promise.race([Promise.allSettled([...inFlight]), deadline]);
  clearTimeout(timer);
  const workers = [...pools.values()].flatMap((pool) => pool.ready.splice(0));
  pools.clear();
  await Promise.all(workers.map((worker) => discard(worker, "gateway shutting down")));
}
