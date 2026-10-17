import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token bucket: `burst` requests at once, then one more every `refillMs`. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly burst: number, private readonly refillMs: number) {
    // Full buckets carry no information, so idle keys are dropped to keep memory bounded.
    setInterval(() => this.prune(), 60_000).unref();
  }

  /** Takes one token for `key`. Returns 0 when allowed, otherwise the seconds until the next token. */
  take(key: string): number {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updatedAt) / this.refillMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) * this.refillMs) / 1000);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) / this.refillMs >= this.burst) this.buckets.delete(key);
    }
  }
}

/** The caller's address. Behind a proxy (TRUST_PROXY=1) it is the first X-Forwarded-For entry. */
export function clientAddress(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}
