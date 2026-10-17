import {
  ARTIFACT_DIGEST_COMMAND,
  emit,
  PLATFORM_URL,
  readPlatformView,
  verifyManifest,
  type CheckResult,
  type PurchaseGrant,
  type SignedManifest,
} from "@polygraph/core";
import { getJson, isRecord } from "./http.js";
import { bundleBytes, bundleDigest, downloadBundle, type Bundle } from "./bundle.js";
import { verifyPythonHooks, verifySystemPackages } from "./integrity.js";
import { keyFingerprint, shortFingerprint, type SellerPins } from "./pins.js";
import { RemoteSandbox } from "./worker.js";

export interface Verdict {
  passed: boolean;
  checks: CheckResult[];
  /** One line of evidence per failed check, for the refusal event. */
  reason?: string;
}

export interface WorkerVerdict extends Verdict {
  /** The tool exactly as downloaded and hashed by the buyer, when that step was reached. */
  bundle?: Bundle;
}

/** Collects checks for one offer and streams each one to the dashboard as it is decided. */
class Checklist {
  readonly checks: CheckResult[] = [];

  constructor(private readonly offerId: string) {}

  async record(id: string, label: string, passed: boolean, detail: string): Promise<boolean> {
    const check: CheckResult = { id, label, status: passed ? "pass" : "fail", detail };
    this.checks.push(check);
    await emit({ type: "buyer.check", offerId: this.offerId, check });
    return passed;
  }

  verdict(): Verdict {
    const failed = this.checks.filter((check) => check.status === "fail");
    if (failed.length === 0) return { passed: true, checks: this.checks };
    return { passed: false, checks: this.checks, reason: failed.map((check) => `${check.label}: ${check.detail}`).join("; ") };
  }
}

/** Egress lists are compared as sets of exact rules: order does not matter, spelling does. */
export const sameRules = (a: string[], b: string[]) =>
  a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const formatRules = (rules: string[]) => (rules.length ? `[${[...rules].sort().join(", ")}]` : "[] (no rules, open internet)");

const shortHash = (hash: string) => (hash.length > 16 ? `${hash.slice(0, 16)}…` : hash || "(empty)");

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function inspectToken(gateway: string, offerId: string): Promise<string> {
  const body = await getJson(`${gateway}/offers/${encodeURIComponent(offerId)}/inspect`);
  if (!isRecord(body) || typeof body.token !== "string" || !body.token) throw new Error("inspect response has no token");
  return body.token;
}

/** Recomputes the tool digest inside the worker with the same command the seller ran before signing. */
export async function toolDigest(worker: RemoteSandbox): Promise<string> {
  const run = await worker.sh(ARTIFACT_DIGEST_COMMAND);
  const digest = /^([0-9a-f]{64})\b/.exec(run.stdout.trim())?.[1];
  if (run.exitCode !== 0 || !digest) {
    throw new Error(`digest command exited ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
  }
  return digest;
}

/**
 * Checks an offer before any money moves: the signature, then the parent sandbox as CreateOS
 * itself reports it. The parent id comes from the signed manifest, so the gateway cannot point
 * the buyer at a different sandbox without breaking the signature.
 */
export async function verifyOffer(gateway: string, offer: SignedManifest, pins: SellerPins): Promise<Verdict> {
  const { manifest } = offer;
  const list = new Checklist(manifest.offerId);
  await emit({ type: "buyer.step", step: "verify-offer", detail: `${manifest.offerId} · ${manifest.name} · $${manifest.priceUsd}` });

  const signature = verifyManifest(offer);
  const fingerprint = keyFingerprint(offer.publicKey);
  const signedBy = `key ${shortFingerprint(fingerprint)}`;
  if (!(await list.record("signature", "Seller signature covers this manifest", signature.valid, signature.valid ? signedBy : (signature.reason ?? "invalid")))) {
    return list.verdict();
  }

  const pin = await pins.check(gateway, manifest.offerId, fingerprint);
  if (pin.status === "unpinned") {
    await list.record("seller-key", "Seller key fingerprint (not pinned)", true, `${fingerprint} · pin it with --trust-seller`);
  } else if (pin.status === "pinned-now") {
    await list.record("seller-key", "Seller key pinned on first use", true, fingerprint);
  } else {
    const pinned = `pinned ${shortFingerprint(pin.pin.fingerprint)} on ${pin.pin.pinnedAt.slice(0, 10)}`;
    const detail = pin.status === "match" ? `${fingerprint} · ${pinned}` : `${pinned} · this offer ${shortFingerprint(fingerprint)}`;
    if (!(await list.record("seller-key", "Seller key is the one you pinned", pin.status === "match", detail))) return list.verdict();
  }

  let token: string;
  try {
    token = await inspectToken(gateway, manifest.offerId);
  } catch (err) {
    await list.record("inspect", "Read access to the parent sandbox", false, errorText(err));
    return list.verdict();
  }

  const read = await readPlatformView(manifest.parentSandboxId, token);
  const view = read.view;
  const found = `${manifest.parentSandboxId} found on CreateOS${view ? ` (${view.rootfs})` : ""}`;
  if (!(await list.record("parent-exists", "Parent sandbox exists", Boolean(view), view ? found : `CreateOS returned HTTP ${read.status} for ${manifest.parentSandboxId}`)) || !view) {
    return list.verdict();
  }

  await list.record("parent-paused", "Parent is paused", view.status === "paused", `CreateOS status: ${view.status}`);
  await list.record(
    "egress-claim",
    "Egress matches the signed claim",
    sameRules(manifest.egress, view.egress),
    `claimed ${formatRules(manifest.egress)} · CreateOS ${formatRules(view.egress)}`,
  );
  await list.record(
    "egress-locked",
    "Egress is deny-by-default",
    view.egress.length > 0,
    view.egress.length > 0 ? `${view.egress.length} allowed, everything else blocked by CreateOS` : "CreateOS has no egress rules for this sandbox",
  );
  return list.verdict();
}

/**
 * Checks the paid worker before the buyer's document goes anywhere near it: lineage, firewall and
 * status from CreateOS, the tool hashed by the buyer from downloaded bytes and again inside the
 * worker, then the system packages and Python startup hooks around the tool.
 */
export async function verifyWorker(offer: SignedManifest, grant: PurchaseGrant, receiptReference: string | null): Promise<WorkerVerdict> {
  const { manifest } = offer;
  const list = new Checklist(manifest.offerId);
  await emit({ type: "buyer.step", step: "verify-worker", detail: `${grant.workerSandboxId} · purchase ${grant.purchaseId}` });

  await list.record("grant-offer", "Grant is for the offer paid for", grant.offerId === manifest.offerId, `grant ${grant.offerId} · paid ${manifest.offerId}`);
  await list.record(
    "receipt",
    "Payment receipt matches the grant",
    receiptReference === grant.paymentIntentId,
    `receipt ${receiptReference ?? "missing"} · grant ${grant.paymentIntentId}`,
  );
  // The buyer always talks to the CreateOS API it already trusts; a grant naming another host is a red flag.
  const [named, trusted] = [grant.platformUrl, PLATFORM_URL].map((url) => url.replace(/\/+$/, ""));
  await list.record("platform", "Grant names the trusted CreateOS API", named === trusted, `grant ${named} · buyer ${trusted}`);

  const read = await readPlatformView(grant.workerSandboxId, grant.workerToken);
  const view = read.view;
  if (!(await list.record("worker-exists", "Worker is visible with its token", Boolean(view), view ? `${view.sandboxId} (${view.rootfs})` : `CreateOS returned HTTP ${read.status}`)) || !view) {
    return list.verdict();
  }

  await list.record(
    "worker-lineage",
    "Worker was forked from the signed parent",
    view.forkedFrom === manifest.parentSandboxId,
    `forked_from ${view.forkedFrom ?? "(none)"} · signed parent ${manifest.parentSandboxId}`,
  );
  await list.record(
    "worker-egress",
    "Worker egress matches the signed claim",
    sameRules(manifest.egress, view.egress),
    `claimed ${formatRules(manifest.egress)} · CreateOS ${formatRules(view.egress)}`,
  );
  if (!(await list.record("worker-running", "Worker is running", view.status === "running", `CreateOS status: ${view.status}`))) {
    return list.verdict();
  }

  const worker = new RemoteSandbox(grant.workerSandboxId, grant.workerToken);
  let bundle: Bundle | undefined;
  try {
    bundle = await downloadBundle(worker);
    const digest = bundleDigest(bundle);
    await list.record(
      "artifact-digest-local",
      "Tool files hashed by the buyer match the signed digest",
      digest === manifest.artifactDigest,
      `${bundle.size} files, ${bundleBytes(bundle)} bytes · signed ${shortHash(manifest.artifactDigest)} · buyer ${shortHash(digest)}`,
    );
  } catch (err) {
    await list.record("artifact-digest-local", "Tool files hashed by the buyer match the signed digest", false, errorText(err));
  }

  const probes: [string, string, () => Promise<{ passed: boolean; detail: string }>][] = [
    ["artifact-digest", "Tool digest computed in the worker matches", async () => {
      const digest = await toolDigest(worker);
      return { passed: digest === manifest.artifactDigest, detail: `signed ${shortHash(manifest.artifactDigest)} · worker ${shortHash(digest)}` };
    }],
    ["system-packages", "LibreOffice packages are unmodified", () => verifySystemPackages(worker)],
    ["python-hooks", "No added Python startup hooks", () => verifyPythonHooks(worker)],
  ];
  for (const [id, label, probe] of probes) {
    try {
      const finding = await probe();
      await list.record(id, label, finding.passed, finding.detail);
    } catch (err) {
      await list.record(id, label, false, errorText(err));
    }
  }
  return { ...list.verdict(), bundle };
}
