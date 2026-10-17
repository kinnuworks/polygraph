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

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

export const config = {
  port: Number(process.env.PORT ?? 4242),
  publicUrl: (process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242").replace(/\/+$/, ""),
  offersDir: resolve(repoRoot, "data/offers"),
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
  /** Card payments through Stripe SPTs have a $0.50 minimum. */
  defaultPriceUsd: "0.50",
  /** An inspect token for a parent sandbox is revoked this long after it was last handed out. */
  inspectTokenTtlMs: 60_000,
  /** Running workers kept pre-forked per offer, so a sale skips the fork wait. */
  poolSize: parsePoolSize(process.env.POOL_SIZE),
  /** Offer ids that get a warm pool. Empty means every offer; set it when sandbox quota is tight. */
  poolOffers: new Set((process.env.POOL_OFFERS ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
  /** How often pools are refilled and checked, and untracked workers destroyed. */
  sweepIntervalMs: 60_000,
  /** After CreateOS refuses a fork for quota or credit reasons, pools stop forking for this long. */
  forkBackoffMs: 2 * 60_000,
  /** Workers the gateway created and has not destroyed, kept on disk so a crash leaves nothing behind after the next start. */
  ledgerPath: resolve(fileURLToPath(new URL(".", import.meta.url)), "../.runtime/workers.json"),
  /** A worker that is never marked done is destroyed after this long. */
  purchaseTtlMs: 15 * 60_000,
} as const;
