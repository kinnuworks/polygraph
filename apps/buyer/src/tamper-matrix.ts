/**
 * Tamper matrix: runs the buyer's real verification against dishonest variants of the live offers
 * and records where each one is stopped. Cases 1 to 5 must be refused before any payment; case 6
 * needs one real test-mode purchase and must be refunded after the buyer hashes the tool.
 *
 * npm run tamper-matrix -- --gateway <url> [--genuine ID] [--lying ID] [--tampered ID]
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emit, loadSigningKey, signManifest, type OfferManifest, type SignedManifest } from "@polygraph/core";
import { discover } from "./discover.js";
import { getJson, isRecord } from "./http.js";
import { buyOffer, checkQuote, PaymentDeclined } from "./pay.js";
import { keyFingerprint, SellerPins } from "./pins.js";
import { tellGateway } from "./purchases.js";
import { formatTable } from "./summary.js";
import { verifyOffer, verifyWorker, type Verdict } from "./verify.js";

type Outcome = "passed (control)" | "refused before payment" | "declined before payment" | "refunded after payment" | "NOT REFUSED" | "error";

interface CaseResult {
  id: string;
  name: string;
  offerId: string;
  /** Check that must be the one to stop this offer. */
  expected: string;
  outcome: Outcome;
  /** Whether the result is what the matrix expects. */
  ok: boolean;
  evidence: string;
  paymentIntentId?: string;
  refundId?: string;
}

const OUTPUT = resolve("data/buyer/tamper-matrix.json");
/** A well-formed sandbox id that does not exist on CreateOS. */
const MISSING_PARENT = "sb-01m5500000000000000000000x";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function failedCheck(verdict: Verdict, id: string): string | null {
  const check = verdict.checks.find((c) => c.id === id && c.status === "fail");
  return check ? `${check.label} · ${check.detail ?? ""}` : null;
}

function pickOffer(offers: SignedManifest[], id: string | undefined, nameMatch: RegExp, role: string): SignedManifest {
  const offer = id ? offers.find((o) => o.manifest.offerId === id) : offers.find((o) => nameMatch.test(o.manifest.name));
  if (!offer) throw new Error(`no ${role} offer on the gateway${id ? ` with id ${id}` : ` named like ${nameMatch}`}`);
  return offer;
}

/** True when the gateway can hand out a read token for the offer's parent, i.e. the parent still exists. */
async function inspectable(gateway: string, offerId: string): Promise<boolean> {
  try {
    await getJson(`${gateway}/offers/${encodeURIComponent(offerId)}/inspect`);
    return true;
  } catch {
    return false;
  }
}

/** Counts PaymentIntents created on the Stripe test account since `since` (unix seconds). */
async function paymentIntentsSince(since: number): Promise<number | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const res = await fetch(`https://api.stripe.com/v1/payment_intents?limit=100&created[gte]=${since}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
  });
  const body: unknown = await res.json();
  return isRecord(body) && Array.isArray(body.data) ? body.data.length : null;
}

/** Runs pre-payment verification and expects it to stop the offer at one named check. */
async function expectRefusal(gateway: string, pins: SellerPins, base: Omit<CaseResult, "outcome" | "ok" | "evidence">, offer: SignedManifest): Promise<CaseResult> {
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: `case ${base.id}: ${base.name}` });
  const verdict = await verifyOffer(gateway, offer, pins);
  if (verdict.passed) return { ...base, outcome: "NOT REFUSED", ok: false, evidence: "every pre-payment check passed" };
  await emit({ type: "buyer.refused", offerId: offer.manifest.offerId, reason: `tamper matrix case ${base.id}: ${verdict.reason}` });
  const hit = failedCheck(verdict, base.expected);
  return { ...base, outcome: "refused before payment", ok: hit !== null, evidence: hit ?? verdict.reason ?? "" };
}

async function priceSwap(gateway: string, pins: SellerPins, base: Omit<CaseResult, "outcome" | "ok" | "evidence">, offer: SignedManifest): Promise<CaseResult> {
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: `case ${base.id}: ${base.name}` });
  const verdict = await verifyOffer(gateway, offer, pins);
  if (!verdict.passed) return { ...base, outcome: "refused before payment", ok: false, evidence: `stopped earlier than expected: ${verdict.reason}` };
  try {
    await checkQuote(gateway, offer.manifest);
    return { ...base, outcome: "NOT REFUSED", ok: false, evidence: "402 amount matched the signed price" };
  } catch (err) {
    if (!(err instanceof PaymentDeclined)) return { ...base, outcome: "error", ok: false, evidence: errorText(err) };
    await emit({ type: "buyer.refused", offerId: offer.manifest.offerId, reason: `tamper matrix case ${base.id}: ${err.message}` });
    return { ...base, outcome: "declined before payment", ok: true, evidence: `${err.message}; no payment token was requested` };
  }
}

/** The one case that needs money: pay for the tampered tool, catch it by hashing, ask for the refund. */
async function tamperedTool(gateway: string, pins: SellerPins, base: Omit<CaseResult, "outcome" | "ok" | "evidence">, offer: SignedManifest): Promise<CaseResult> {
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: `case ${base.id}: ${base.name} (real test-mode purchase)` });
  const before = await verifyOffer(gateway, offer, pins);
  if (!before.passed) return { ...base, outcome: "refused before payment", ok: false, evidence: `stopped before payment instead: ${before.reason}` };

  let payment;
  try {
    payment = await buyOffer(gateway, offer.manifest, "test");
  } catch (err) {
    return { ...base, outcome: "error", ok: false, evidence: `purchase failed: ${errorText(err)}` };
  }
  const { grant } = payment;
  const after = await verifyWorker(offer, grant, payment.receiptReference);
  if (after.passed) {
    await tellGateway(gateway, grant, "done");
    return { ...base, outcome: "NOT REFUSED", ok: false, evidence: "every worker check passed", paymentIntentId: grant.paymentIntentId };
  }
  await emit({ type: "buyer.refused", offerId: offer.manifest.offerId, reason: `after payment, document withheld: ${after.reason}` });
  const answer = await tellGateway(gateway, grant, "refund", after.reason);
  const refundId = isRecord(answer) && typeof answer.refundId === "string" ? answer.refundId : undefined;
  const hit = failedCheck(after, base.expected);
  return {
    ...base,
    outcome: "refunded after payment",
    ok: hit !== null && refundId !== undefined,
    evidence: `${hit ?? after.reason}${refundId ? "" : " · gateway did not confirm a refund"}`,
    paymentIntentId: grant.paymentIntentId,
    ...(refundId ? { refundId } : {}),
  };
}

const { values } = parseArgs({
  options: {
    gateway: { type: "string" },
    genuine: { type: "string" },
    lying: { type: "string" },
    tampered: { type: "string" },
  },
});
const gateway = (values.gateway ?? process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242").replace(/\/+$/, "");
process.env.POLYGRAPH_GATEWAY_URL = gateway;

try {
  const startedAt = new Date();
  const since = Math.floor(startedAt.getTime() / 1000) - 1;
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: `starting against ${gateway}` });

  const { offers } = await discover(gateway);
  const genuine = pickOffer(offers, values.genuine, /^Document to PDF \(LibreOffice\)$/, "genuine");
  const lying = pickOffer(offers, values.lying, /tampered live/i, "lying-egress");
  const tampered = pickOffer(offers, values.tampered, /foil B/i, "tampered-tool");

  // Pin the genuine seller key in a throwaway file, as a returning buyer would have.
  const pinsFile = join(await mkdtemp(join(tmpdir(), "polygraph-pins-")), "trusted-sellers.json");
  const pins = await SellerPins.load(pinsFile, true);
  const genuineKey = keyFingerprint(genuine.publicKey);
  await pins.check(gateway, genuine.manifest.offerId, genuineKey);

  // Dishonest copies of the genuine manifest. The seller's own key signs the ones that must get
  // past the signature, so only the lie itself can stop them.
  const sellerKey = loadSigningKey();
  const sellerSigns = keyFingerprint(sellerKey.publicKey.export({ format: "jwk" })) === genuineKey;
  const resign = (manifest: OfferManifest) => signManifest(manifest, sellerKey.privateKey, sellerKey.publicKey);
  const stranger = generateKeyPairSync("ed25519");
  const edited: SignedManifest = { ...genuine, manifest: { ...genuine.manifest, priceUsd: "0.01" } };
  const otherKey = signManifest(genuine.manifest, stranger.privateKey, stranger.publicKey);
  const pricey = resign({ ...genuine.manifest, priceUsd: "0.75" });
  const orphan = resign({ ...genuine.manifest, parentSandboxId: MISSING_PARENT });
  const g = genuine.manifest.offerId;

  const results: CaseResult[] = [];
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: "control: the genuine offer, pre-payment checks only" });
  const control = await verifyOffer(gateway, genuine, pins);
  results.push({
    id: "control",
    name: "genuine offer",
    offerId: g,
    expected: "all pass",
    outcome: control.passed ? "passed (control)" : "error",
    ok: control.passed,
    evidence: control.passed ? `${control.checks.length} pre-payment checks passed, not bought` : (control.reason ?? ""),
  });
  results.push(await expectRefusal(gateway, pins, { id: "1", name: "edited after signing (price 0.50 -> 0.01)", offerId: g, expected: "signature" }, edited));
  // The live lying offer is preferred; if its parent is gone, a seller-signed copy of the genuine
  // manifest that claims a different egress list tests the same comparison.
  const liveLiar = await inspectable(gateway, lying.manifest.offerId);
  const liar = liveLiar ? lying : resign({ ...genuine.manifest, egress: ["pypi.org"] });
  const liarName = liveLiar ? "lying egress (live offer)" : "lying egress (signed claim [pypi.org]; live offer's parent is gone)";
  results.push(await expectRefusal(gateway, pins, { id: "2", name: liarName, offerId: liar.manifest.offerId, expected: "egress-claim" }, liar));
  results.push(await expectRefusal(gateway, pins, { id: "3", name: "re-signed by a different key", offerId: g, expected: "seller-key" }, otherKey));
  results.push(await priceSwap(gateway, pins, { id: "4", name: "price swap (signed $0.75, 402 asks $0.50)", offerId: g, expected: "402 amount" }, pricey));
  results.push(await expectRefusal(gateway, pins, { id: "5", name: "missing parent sandbox", offerId: g, expected: "parent-exists" }, orphan));
  const prepaymentIntents = await paymentIntentsSince(since);
  results.push(await tamperedTool(gateway, pins, { id: "6", name: "tampered tool (live offer)", offerId: tampered.manifest.offerId, expected: "artifact-digest-local" }, tampered));

  const dishonest = results.filter((r) => r.id !== "control");
  const refusedBefore = dishonest.filter((r) => r.ok && r.outcome !== "refunded after payment").length;
  const refundedAfter = dishonest.filter((r) => r.ok && r.outcome === "refunded after payment").length;
  const allOk = results.every((r) => r.ok) && prepaymentIntents === 0;
  const headline =
    `${refusedBefore + refundedAfter} of ${dishonest.length} dishonest offers refused; ${refusedBefore} before any payment, ` +
    `${refundedAfter} refunded after the buyer hashed the tool`;

  const rows = results.map((r) => [
    r.id,
    r.name,
    r.expected,
    r.outcome,
    r.ok ? "yes" : "NO",
    [r.paymentIntentId, r.refundId].filter(Boolean).join(" -> ") || "-",
    r.evidence,
  ]);
  console.log(`\nTamper matrix · ${gateway}\n`);
  console.log(formatTable(["case", "dishonest offer", "must fail", "outcome", "as expected", "payment", "evidence"], rows, 70));
  console.log(`\nPaymentIntents created during cases 1-5: ${prepaymentIntents ?? "unknown (no STRIPE_SECRET_KEY)"}`);
  console.log(sellerSigns ? "Cases 4 and 5 are signed with the seller's real key." : "Cases 4 and 5 are signed with a local key that differs from the live seller's.");
  console.log(`${headline}\n`);

  await mkdir(resolve("data/buyer"), { recursive: true });
  await writeFile(
    OUTPUT,
    `${JSON.stringify({ gateway, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), headline, prepaymentIntents, sellerSigns, results }, null, 2)}\n`,
  );
  console.log(`Wrote ${OUTPUT}`);
  await emit({ type: "buyer.step", step: "tamper-matrix", detail: headline });
  process.exit(allOk ? 0 : 1);
} catch (err) {
  console.error(`tamper matrix stopped: ${errorText(err)}`);
  process.exit(1);
}
