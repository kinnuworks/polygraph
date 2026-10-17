import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { CreateosSandboxTimeoutError, type Sandbox } from "@nodeops-createos/sandbox";
import {
  ARTIFACT_DIGEST_COMMAND,
  canonicalJson,
  loadSigningKey,
  readPlatformView,
  signManifest,
  TOOL_DIR,
  verifyManifest,
  type CheckResult,
  type OfferManifest,
  type SignedManifest,
} from "@polygraph/core";
import { config } from "./config.js";
import { publish } from "./events.js";
import { handOut } from "./inspect.js";
import { getOffer, isChargeable, offersWithLabels, publicView, removeOffer, storePublishedOffer } from "./offers.js";
import { syncPools } from "./pool.js";
import { clientAddress, RateLimiter } from "./ratelimit.js";
import { destroyWorker, getSandbox } from "./sandbox.js";
import { forgetWorker, touchWorker, trackWorker } from "./workers.js";

/*
 * "Tamper it yourself": a visitor makes the gateway build a validly signed offer whose claims are false in
 * one way, then watches the buyer's pre-payment checks run against CreateOS. Ported from the seller's foils:
 *   egress:   the parent's egress is opened while the manifest keeps the genuine locked list.
 *   artifact: one byte of convert.py changes while the manifest keeps the genuine digest.
 */

export type TamperKind = "egress" | "artifact";

/** Foil labels the seller uses for the same two kinds; a visitor's tamper replaces the standing foil. */
const FOIL_LABEL: Record<TamperKind, string> = { egress: "lying-egress", artifact: "tampered-artifact" };

const TAMPERED_NAME = "Document to PDF (tampered by a visitor)";
const RATE_WINDOW_MS = 90_000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The same comparisons and wording as the buyer agent, so the dashboard reads the same either way.
const sameRules = (a: string[], b: string[]) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const formatRules = (rules: string[]) => (rules.length ? `[${[...rules].sort().join(", ")}]` : "[] (no rules, open internet)");
const keyFingerprint = (jwk: JsonWebKey) => {
  const members = jwk.kty === "OKP" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x } : jwk;
  return `SHA256:${createHash("sha256").update(canonicalJson(members)).digest("base64url")}`;
};
const shortFingerprint = (fingerprint: string) => `${fingerprint.slice(0, 23)}…`;

/** The newest honest offer: no foil label, chargeable. */
async function genuineOffer(): Promise<SignedManifest | null> {
  const honest = (await offersWithLabels()).filter((c) => c.foil === null && isChargeable(c.offer.manifest.priceUsd));
  honest.sort((a, b) => (Date.parse(b.offer.manifest.createdAt) || 0) - (Date.parse(a.offer.manifest.createdAt) || 0));
  return honest[0]?.offer ?? null;
}

/** Withdraws every offer of this foil kind and destroys its parent, so the sandbox count stays the same. */
async function withdrawSameKind(kind: TamperKind, genuineParent: string): Promise<void> {
  const label = FOIL_LABEL[kind];
  const previous = (await offersWithLabels()).filter((c) => c.foil === label);
  for (const { offer } of previous) {
    const { offerId, parentSandboxId } = offer.manifest;
    const wasListed = (await getOffer(offerId)) !== null;
    await removeOffer(offerId);
    if (wasListed) publish({ type: "offer.removed", offerId });
    // Never the genuine parent, whatever a foil's manifest says.
    if (parentSandboxId !== genuineParent) {
      try {
        // Waiting frees the quota slot before the new fork; CreateOS sometimes takes minutes, so give up waiting after 30 s.
        await destroyWorker(parentSandboxId, { untilGone: true });
        console.log(`[tamper] withdrew ${offerId} and destroyed its parent ${parentSandboxId}`);
      } catch (err) {
        if (!(err instanceof CreateosSandboxTimeoutError)) throw err;
        console.warn(`[tamper] withdrew ${offerId}; its parent ${parentSandboxId} is still being destroyed`);
      }
    }
  }
}

/** Opens the egress of a paused fork. Egress is a control-plane setting, so the fork can stay paused. */
async function openEgress(fork: Sandbox, genuine: OfferManifest): Promise<string> {
  await fork.setEgress(null);
  const egress = (await fork.getEgress()).egress ?? [];
  if (egress.length !== 0) throw new Error(`egress still restricted after opening: [${egress.join(", ")}]`);
  return `egress opened; the manifest still states ${formatRules(genuine.egress)}`;
}

/** Flips the last byte of convert.py between newline and space: Python still parses it, its hash changes. */
async function changeOneByte(fork: Sandbox, genuine: OfferManifest): Promise<string> {
  const flip = `python3 -c 'import sys; p=sys.argv[1]; d=bytearray(open(p,"rb").read()); d[-1] = 0x20 if d[-1] == 0x0a else 0x0a; open(p,"wb").write(d)' ${TOOL_DIR}/convert.py`;
  const edit = await fork.runCommand("bash", ["-c", flip], { timeoutMs: 30_000 });
  if (edit.result.exit_code !== 0) throw new Error(`editing convert.py failed: ${edit.result.stderr.trim()}`);
  const run = await fork.runCommand("bash", ["-c", ARTIFACT_DIGEST_COMMAND], { timeoutMs: 60_000 });
  const digest = run.result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`digest command failed: ${run.result.stderr.trim()}`);
  if (digest === genuine.artifactDigest) throw new Error("digest unchanged after editing convert.py");
  return `convert.py changed by one byte, digest now ${digest.slice(0, 12)}…; the manifest still states ${genuine.artifactDigest.slice(0, 12)}…`;
}

/** Forks the genuine parent and tampers with the fork, leaving it paused like any offer parent. */
async function tamperedParent(genuine: OfferManifest, kind: TamperKind): Promise<{ fork: Sandbox; change: string }> {
  const parent = await getSandbox(genuine.parentSandboxId);
  if (parent.status !== "paused") throw new Error(`genuine parent ${parent.id} is ${parent.status}, expected paused`);
  const fork = await parent.fork({ start_paused: kind === "egress" });
  // Tracked while it is being set up, so the sweeps leave it alone and a crash leaves nothing behind.
  trackWorker(fork.id);
  try {
    if (kind === "egress") {
      await fork.waitUntilPaused({ timeoutMs: config.forkReadyTimeoutMs });
      return { fork, change: await openEgress(fork, genuine) };
    }
    await fork.waitUntilRunning({ timeoutMs: config.forkReadyTimeoutMs });
    touchWorker(fork.id);
    const change = await changeOneByte(fork, genuine);
    await fork.pause();
    await fork.waitUntilPaused({ timeoutMs: 120_000 });
    return { fork, change };
  } catch (err) {
    await destroyWorker(fork).catch(() => undefined);
    throw err;
  }
}

/** Collects checks and streams each one as a buyer.check event, as the buyer agent does. */
class Checklist {
  readonly checks: CheckResult[] = [];

  constructor(private readonly offerId: string) {}

  record(id: string, label: string, passed: boolean, detail: string): boolean {
    const check: CheckResult = { id, label, status: passed ? "pass" : "fail", detail };
    this.checks.push(check);
    publish({ type: "buyer.check", offerId: this.offerId, check });
    return passed;
  }

  failures(): string[] {
    return this.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`);
  }
}

/** The buyer's pre-payment checks (apps/buyer verifyOffer), run by the gateway against CreateOS. */
async function prePaymentChecks(offer: SignedManifest): Promise<Checklist> {
  const { manifest } = offer;
  const list = new Checklist(manifest.offerId);
  publish({ type: "buyer.step", step: "verify-offer", detail: `${manifest.offerId} · ${manifest.name} · $${manifest.priceUsd}` });

  const signature = verifyManifest(offer);
  const fingerprint = keyFingerprint(offer.publicKey);
  if (!list.record("signature", "Seller signature covers this manifest", signature.valid, signature.valid ? `key ${shortFingerprint(fingerprint)}` : (signature.reason ?? "invalid"))) {
    return list;
  }
  list.record("seller-key", "Seller key fingerprint (not pinned)", true, fingerprint);

  let token: string;
  try {
    token = (await handOut(manifest.parentSandboxId)).token;
  } catch (err) {
    list.record("inspect", "Read access to the parent sandbox", false, errorMessage(err));
    return list;
  }
  const read = await readPlatformView(manifest.parentSandboxId, token);
  const view = read.view;
  const found = `${manifest.parentSandboxId} found on CreateOS${view ? ` (${view.rootfs})` : ""}`;
  if (!list.record("parent-exists", "Parent sandbox exists", Boolean(view), view ? found : `CreateOS returned HTTP ${read.status} for ${manifest.parentSandboxId}`) || !view) {
    return list;
  }
  list.record("parent-paused", "Parent is paused", view.status === "paused", `CreateOS status: ${view.status}`);
  list.record("egress-claim", "Egress matches the signed claim", sameRules(manifest.egress, view.egress), `claimed ${formatRules(manifest.egress)} · CreateOS ${formatRules(view.egress)}`);
  list.record(
    "egress-locked",
    "Egress is deny-by-default",
    view.egress.length > 0,
    view.egress.length > 0 ? `${view.egress.length} allowed, everything else blocked by CreateOS` : "CreateOS has no egress rules for this sandbox",
  );
  return list;
}

class TamperError extends Error {
  constructor(message: string, readonly status: 409 | 502 | 503) {
    super(message);
  }
}

async function tamper(kind: TamperKind): Promise<{ offerId: string; kind: TamperKind; refused: boolean; checks: CheckResult[] }> {
  if (!process.env.SELLER_SIGNING_KEY) throw new TamperError("SELLER_SIGNING_KEY is not set, so a tampered offer cannot carry the seller's signature", 503);
  const genuine = await genuineOffer();
  if (!genuine) throw new TamperError("no genuine offer is published to tamper with", 409);

  publish({ type: "seller.step", step: "visitor-tamper", detail: `a visitor asked to ${kind === "egress" ? "open the egress of" : "change one byte of the tool in"} a copy of ${genuine.manifest.offerId}` });
  await withdrawSameKind(kind, genuine.manifest.parentSandboxId);

  const started = Date.now();
  const { fork, change } = await tamperedParent(genuine.manifest, kind);
  const manifest: OfferManifest = {
    ...genuine.manifest,
    offerId: `offer_${randomBytes(6).toString("hex")}`,
    name: TAMPERED_NAME,
    parentSandboxId: fork.id,
    createdAt: new Date().toISOString(),
  };
  const { privateKey, publicKey } = loadSigningKey();
  const signed = signManifest(manifest, privateKey, publicKey);
  await storePublishedOffer(signed, FOIL_LABEL[kind]);
  // Now an offer parent, which the sweeps never touch; it is no longer a worker in setup.
  forgetWorker(fork.id);
  publish({ type: "seller.step", step: "visitor-tamper", detail: `${manifest.offerId} parent ${fork.id}: ${change} (${((Date.now() - started) / 1000).toFixed(1)} s)` });
  if ((await getOffer(manifest.offerId)) !== null) publish({ type: "offer.published", offer: publicView(signed) });
  syncPools().catch((err) => console.error(`[tamper] pool refresh failed: ${errorMessage(err)}`));

  const list = await prePaymentChecks(signed);
  const failures = list.failures();
  if (failures.length > 0) {
    publish({ type: "buyer.refused", offerId: manifest.offerId, reason: failures.join("; ") });
  } else {
    publish({
      type: "buyer.step",
      step: "pre-payment-passed",
      detail: `${manifest.offerId}: this tamper is only visible inside a worker; run the buyer to see it refunded`,
    });
  }
  return { offerId: manifest.offerId, kind, refused: failures.length > 0, checks: list.checks };
}

const perClient = new RateLimiter(1, RATE_WINDOW_MS);
const overall = new RateLimiter(1, RATE_WINDOW_MS);
let running = false;

/** POST /demo/tamper, only when DEMO_TAMPER=1. */
export function registerTamperRoutes(app: Hono): void {
  if (!config.demoTamper) return;

  app.post("/demo/tamper", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { kind?: unknown } | null;
    const kind = body?.kind;
    if (kind !== "egress" && kind !== "artifact") return c.json({ error: 'body must be { "kind": "egress" | "artifact" }' }, 400);
    if (running) return c.json({ error: "a tamper is already under way; watch the feed" }, 429);
    const retry = perClient.take(clientAddress(c)) || overall.take("all");
    if (retry > 0) {
      c.header("Retry-After", String(retry));
      return c.json({ error: `one tamper every ${RATE_WINDOW_MS / 1000} s; retry in ${retry} s` }, 429);
    }
    running = true;
    try {
      return c.json(await tamper(kind));
    } catch (err) {
      console.error(`[tamper] ${kind}: ${errorMessage(err)}`);
      publish({ type: "seller.step", step: "visitor-tamper", detail: `${kind} tamper failed: ${errorMessage(err)}` });
      return c.json({ error: errorMessage(err) }, err instanceof TamperError ? err.status : 502);
    } finally {
      running = false;
    }
  });
}
