import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PLATFORM_URL } from "@polygraph/core";

const REQUIRED = ["CREATEOS_SANDBOX_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_PROFILE_ID", "MPP_SECRET_KEY"] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Gateway cannot start, missing environment variables: ${missing.join(", ")}`);
}

const env = (name: (typeof REQUIRED)[number]) => process.env[name] as string;

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
  /** How long an inspect token for a parent sandbox is reused before a fresh one is minted. */
  inspectTokenTtlMs: 4 * 60_000,
  /** A worker that is never marked done is destroyed after this long. */
  purchaseTtlMs: 15 * 60_000,
} as const;
