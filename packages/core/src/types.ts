// Shared contracts between the seller agent, the gateway, the buyer agent and the dashboard.

/** What a seller publishes about a tool it sells. Signed by the seller. */
export interface OfferManifest {
  offerId: string;
  name: string;
  description: string;
  /** Upstream open-source project the tool wraps. */
  source: { repo: string; license: string };
  /** Paused CreateOS sandbox that every paid worker is forked from. */
  parentSandboxId: string;
  /** Egress allowlist the seller claims every worker runs with. */
  egress: string[];
  /** Hash of the packaged tool (wrapper code plus lockfile), hex sha256. */
  artifactDigest: string;
  priceUsd: string;
  /** Results of the seller agent's own tests and attacks, run before publishing. */
  checks: CheckResult[];
  createdAt: string;
}

export interface SignedManifest {
  manifest: OfferManifest;
  /** Compact JWS (EdDSA) over the canonical JSON of `manifest`. */
  jws: string;
  /** Seller public key as a JWK. */
  publicKey: JsonWebKey;
}

export interface CheckResult {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail?: string;
}

/** What the gateway hands a buyer after a successful payment. */
export interface PurchaseGrant {
  purchaseId: string;
  offerId: string;
  /** Fresh worker forked from the attested parent for this purchase only. */
  workerSandboxId: string;
  /** CreateOS access token scoped to that one worker. */
  workerToken: string;
  /** CreateOS API base URL the buyer should query directly. */
  platformUrl: string;
  paymentIntentId: string;
  expiresAt: string;
}

/** What the buyer verifies about its worker, straight from the platform. */
export interface PlatformView {
  sandboxId: string;
  forkedFrom: string | null;
  egress: string[];
  rootfs: string;
  status: string;
}

/** Final record the buyer keeps for each job. */
export interface Receipt {
  purchaseId: string;
  offerId: string;
  paymentIntentId: string;
  artifactDigest: string;
  parentSandboxId: string;
  workerSandboxId: string;
  verification: CheckResult[];
  inputSha256: string;
  outputSha256: string;
  completedAt: string;
}

/** Events every component emits so the dashboard can render the story live. */
export type PolygraphEvent =
  | { type: "seller.step"; ts: string; step: string; detail?: string }
  | { type: "seller.test"; ts: string; passed: number; failed: number; output?: string }
  | { type: "seller.patch"; ts: string; file: string; diff: string }
  | { type: "seller.attack"; ts: string; attack: string; status: "blocked" | "crashed" | "passed"; detail?: string }
  | { type: "offer.published"; ts: string; offer: SignedManifest }
  | { type: "buyer.step"; ts: string; step: string; detail?: string }
  | { type: "buyer.check"; ts: string; offerId: string; check: CheckResult }
  | { type: "buyer.refused"; ts: string; offerId: string; reason: string }
  | { type: "payment.created"; ts: string; paymentIntentId: string; amountUsd: string }
  | { type: "payment.refunded"; ts: string; paymentIntentId: string; reason: string }
  | { type: "worker.forked"; ts: string; workerSandboxId: string; parentSandboxId: string; ms: number }
  | { type: "worker.destroyed"; ts: string; workerSandboxId: string }
  | { type: "job.completed"; ts: string; receipt: Receipt };
