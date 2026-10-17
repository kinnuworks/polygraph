import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PLATFORM_URL } from "@polygraph/core";

const REQUIRED = ["CREATEOS_SANDBOX_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_PROFILE_ID", "MPP_SECRET_KEY"] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Gateway cannot start, missing environment variables: ${missing.join(", ")}`);
}

const env = (name: (typeof REQUIRED)[number]) => process.env[name] as string;

function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) throw new Error(`POOL_SIZE must be a whole number of workers, got "${raw}"`);
  return size;
}

function parseOrphanSweep(raw: string | undefined): "on" | "off" | "dry" {
  if (raw === undefined || raw === "") return process.env.NODE_ENV === "production" ? "on" : "off";
  if (raw === "1") return "on";
  if (raw === "0") return "off";
  if (raw === "dry") return "dry";
  throw new Error(`ORPHAN_SWEEP must be 1, 0 or dry, got "${raw}"`);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const runtimeDir = resolve(here, "../.runtime");

export const config = {
  port: Number(process.env.PORT ?? 4242),
  /** Public base URL for discovery documents. Unset means it is derived from each request. */
  publicUrl: process.env.POLYGRAPH_GATEWAY_URL ? process.env.POLYGRAPH_GATEWAY_URL.replace(/\/+$/, "") : undefined,
  /** Behind a reverse proxy, the client address and public host come from X-Forwarded-* headers. */
  trustProxy: process.env.TRUST_PROXY === "1",
  /** Offers with a foil sidecar are listed only for demos. */
  demoFoils: process.env.DEMO_FOILS === "1",
  /** Offers baked into the deployment. */
  offersDir: resolve(repoRoot, "data/offers"),
  /** Offers published at runtime through the publish API, and tombstones for removed ones. */
  publishedOffersDir: resolve(runtimeDir, "offers"),
  /** Shared secret for POST /offers and DELETE /offers/:id. Unset disables both routes. */
  publishToken: process.env.PUBLISH_TOKEN || undefined,
  webRoot: resolve(repoRoot, "apps/web/public"),
  createos: {
    apiKey: env("CREATEOS_SANDBOX_API_KEY"),
    baseUrl: PLATFORM_URL,
  },
  stripe: {
    secretKey: env("STRIPE_SECRET_KEY"),
    profileId: env("STRIPE_PROFILE_ID"),
    mppSecretKey: env("MPP_SECRET_KEY"),
  },
  /** Card payments through Stripe SPTs have a $0.50 minimum; cheaper offers are not listed. */
  minPriceUsd: 0.5,
  /** An inspect token for a parent sandbox is revoked this long after it was issued. */
  inspectTokenTtlMs: 60_000,
  /** Inspect rate limits: token buckets per client address and per offer. Each inspect rotates the parent's token. */
  inspectLimits: {
    perClient: { burst: 3, refillMs: 5_000 },
    perOffer: { burst: 6, refillMs: 2_000 },
  },
  /** Running workers kept pre-forked per offer, so a sale skips the fork wait. */
  poolSize: parsePoolSize(process.env.POOL_SIZE),
  /** Offer ids that get a warm pool. Empty means every offer; set it when sandbox quota is tight. */
  poolOffers: new Set((process.env.POOL_OFFERS ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
  /**
   * Destroy forks of offer parents that this instance does not hold, such as a warm worker left by a
   * deployment that was put to sleep. "1" on, "0" off, "dry" logs what it would destroy.
   * Default: on in production, off elsewhere, so a local run never touches the live deployment's workers.
   */
  orphanSweep: parseOrphanSweep(process.env.ORPHAN_SWEEP),
  /** A fork younger than this is never treated as an orphan; it may still be starting for its owner. */
  orphanMinAgeMs: 90_000,
  /** How often pools are refilled and checked, and untracked workers destroyed. */
  sweepIntervalMs: 60_000,
  /** Cold forks have taken 30 to 50 s under load; leave room before giving up and refunding. */
  forkReadyTimeoutMs: 180_000,
  /** After CreateOS refuses a fork for quota or credit reasons, pools stop forking for this long. */
  forkBackoffMs: 2 * 60_000,
  /** Workers the gateway created and has not destroyed, kept on disk so a crash leaves nothing behind after the next start. */
  ledgerPath: resolve(runtimeDir, "workers.json"),
  /** Events from a recorded run, baked into the deployment and replayed at the start of the feed. */
  recordedEventsPath: resolve(repoRoot, "data/events/recorded.jsonl"),
  /** Live feed history, so a restart without a redeploy keeps it. */
  eventsLogPath: resolve(runtimeDir, "events.jsonl"),
  /** Purchases, so refund and done keep working across a restart. */
  purchasesPath: resolve(runtimeDir, "purchases.json"),
  /** A worker that is never marked done is destroyed after this long. */
  purchaseTtlMs: 15 * 60_000,
} as const;
