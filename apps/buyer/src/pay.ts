import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Receipt as PaymentReceipt } from "mppx";
import { Mppx, stripe } from "mppx/client";
import { emit, type OfferManifest, type PurchaseGrant } from "@polygraph/core";
import { excerpt, isRecord } from "./http.js";
import { centsToUsd, usdToCents } from "./money.js";

export type PayMode = "test" | "link";

export interface Payment {
  grant: PurchaseGrant;
  /** PaymentIntent id from the Payment-Receipt header, or null when the header was missing or unreadable. */
  receiptReference: string | null;
  amountUsd: string;
}

/** The buyer declined to pay, for example because the 402 asked for more than the signed price. */
export class PaymentDeclined extends Error {}

/** The credential was sent but no grant came back, so money may have moved without a worker. */
export class PaidRequestFailed extends Error {}

/** What the paid request answered, independent of which payment path produced it. */
interface PaidResponse {
  status: number;
  receiptHeader: string | null;
  body: string;
}

const STRIPE_PREVIEW_VERSION = "2026-09-30.preview";
const execFileAsync = promisify(execFile);

/**
 * Mints a single-use test SPT capped at exactly the agreed amount, valid for one hour.
 * The test helper rejects `seller_details`, so the challenge's network id is not sent.
 */
async function mintTestSpt(secretKey: string, amountCents: number, currency: string): Promise<string> {
  const body = new URLSearchParams({
    payment_method: "pm_card_visa",
    "usage_limits[currency]": currency,
    "usage_limits[max_amount]": String(amountCents),
    "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + 3600),
  });
  const res = await fetch("https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_PREVIEW_VERSION,
    },
    body,
  });
  const json: unknown = await res.json();
  if (!res.ok || !isRecord(json) || typeof json.id !== "string") {
    const message = isRecord(json) && isRecord(json.error) ? json.error.message : `HTTP ${res.status}`;
    throw new Error(`Stripe did not mint a test SPT: ${String(message)}`);
  }
  return json.id;
}

function assertChallengeAmount(request: Record<string, unknown>, expectedCents: number): void {
  const amount = String(request.amount);
  const currency = String(request.currency).toLowerCase();
  if (currency !== "usd" || amount !== String(expectedCents)) {
    const asked = currency === "usd" && /^\d+$/.test(amount) ? `$${centsToUsd(Number(amount))}` : `${amount} ${currency} (smallest unit)`;
    throw new PaymentDeclined(`402 asks for ${asked}, the signed price is $${centsToUsd(expectedCents)}`);
  }
}

/** Fetches the 402 challenge and checks its amount; no token exists until `pay()` is called on the result. */
async function prepareTestPayment(url: string, expectedCents: number) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey?.includes("_test_")) throw new Error("--pay test needs a test-mode STRIPE_SECRET_KEY");

  const mppx = Mppx.create({
    polyfill: false,
    methods: [stripe({ paymentMethod: "pm_card_visa", createToken: ({ currency }) => mintTestSpt(secretKey, expectedCents, currency) })],
  });
  const prepared = await mppx.prepareRequest(url, { method: "POST" }, { requirePayment: true });
  assertChallengeAmount(prepared.payment.challenge.request, expectedCents);
  return prepared.payment;
}

async function payWithTestCard(url: string, expectedCents: number): Promise<PaidResponse> {
  const payment = await prepareTestPayment(url, expectedCents);
  const res = await payment.pay();
  return { status: res.status, receiptHeader: res.headers.get("payment-receipt"), body: await res.text() };
}

/** Link CLI prints one JSON document per call in agent mode; take the last parsable line if it streams. */
function parseCliJson(stdout: string): Record<string, unknown> {
  const candidates = [stdout.trim(), ...stdout.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      // Some link-cli commands wrap their single result in a one-element array.
      const first = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed;
      if (isRecord(first)) return first;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`link-cli printed no JSON object: ${stdout.slice(0, 200)}`);
}

async function linkCli(args: string[]): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync("npx", ["-y", "@stripe/link-cli", ...args, "--format", "json"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
    return parseCliJson(stdout);
  } catch (err) {
    const output = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`link-cli ${args.slice(0, 2).join(" ")} failed: ${(output.stdout || output.stderr || output.message).trim().slice(0, 300)}`);
  }
}

/** Reads a `{ command, args }` continuation from link-cli's `_next` block. */
function continuation(result: Record<string, unknown>, key: "poll_argv" | "pay_argv"): string[] {
  const next = isRecord(result._next) ? result._next[key] : undefined;
  if (!isRecord(next) || typeof next.command !== "string" || !Array.isArray(next.args)) {
    throw new Error(`link-cli response has no _next.${key}`);
  }
  return [next.command, ...next.args.map(String)];
}

/**
 * The real buyer path: Link creates a spend request for the 402 amount, a person approves it in
 * the Link app, then the CLI pays with the approved SPT. `--test` keeps the card uncharged.
 */
async function payWithLink(url: string, expectedCents: number, offer: OfferManifest): Promise<PaidResponse> {
  const context =
    `Polygraph buyer agent: one document conversion from offer ${offer.offerId} for $${centsToUsd(expectedCents)}. ` +
    "The worker sandbox is checked on CreateOS before and after paying.";
  const started = await linkCli(["mpp", "pay", url, "-X", "POST", "--test", "--context", context]);

  const spendRequestId = typeof started.id === "string" ? started.id : "";
  if (started.amount !== expectedCents) {
    if (spendRequestId) await linkCli(["spend-request", "cancel", spendRequestId]);
    throw new PaymentDeclined(`Link spend request is for ${String(started.amount)} cents, the signed price is ${expectedCents}`);
  }

  await emit({ type: "buyer.step", step: "awaiting-approval", detail: `approve ${spendRequestId} in the Link app: ${String(started.approval_url)}` });
  const hasNext = isRecord(started._next);
  // link-cli's own poll step returns at once while the request is still pending, so wait here instead.
  const polled = await waitForApproval(spendRequestId);
  if (polled.status !== "approved") throw new PaymentDeclined(`Link spend request ended as ${String(polled.status)}`);

  const paid = hasNext
    ? await linkCli(continuation(started, "pay_argv"))
    : await linkCli(["mpp", "pay", url, "-X", "POST", "--test", "--spend-request-id", spendRequestId]);
  const headers = isRecord(paid.headers) ? paid.headers : {};
  return {
    status: Number(paid.status),
    receiptHeader: typeof headers["payment-receipt"] === "string" ? headers["payment-receipt"] : null,
    body: typeof paid.body === "string" ? paid.body : JSON.stringify(paid.body ?? null),
  };
}

/** Polls a spend request until the person approves or declines it in the Link app (up to 10 minutes). */
async function waitForApproval(spendRequestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const current = await linkCli(["spend-request", "retrieve", spendRequestId]);
    if (current.status !== "pending_approval") return current;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { status: "expired" };
}

function isPurchaseGrant(value: unknown): value is PurchaseGrant {
  if (!isRecord(value)) return false;
  const fields = ["purchaseId", "offerId", "workerSandboxId", "workerToken", "platformUrl", "paymentIntentId"] as const;
  return fields.every((field) => typeof value[field] === "string" && value[field] !== "");
}

function receiptReference(header: string | null): string | null {
  if (!header) return null;
  try {
    return PaymentReceipt.deserialize(header).reference;
  } catch {
    return null;
  }
}

const buyUrl = (gateway: string, offer: OfferManifest) => `${gateway}/offers/${encodeURIComponent(offer.offerId)}/buy`;

/**
 * Asks the gateway for its payment challenge and checks the amount against the signed price,
 * stopping before any token is minted. Throws PaymentDeclined on a mismatch.
 */
export async function checkQuote(gateway: string, offer: OfferManifest): Promise<void> {
  await prepareTestPayment(buyUrl(gateway, offer), usdToCents(offer.priceUsd));
}

/** Pays for one offer at its signed price and returns the worker grant the gateway hands back. */
export async function buyOffer(gateway: string, offer: OfferManifest, mode: PayMode): Promise<Payment> {
  const expectedCents = usdToCents(offer.priceUsd);
  const amountUsd = centsToUsd(expectedCents);
  const url = buyUrl(gateway, offer);
  const via = mode === "test" ? "Stripe test card through a shared payment token" : "Link wallet (needs approval in the Link app)";
  await emit({ type: "buyer.step", step: "pay", detail: `$${amountUsd} for ${offer.offerId} via ${via}` });

  const paid = mode === "test" ? await payWithTestCard(url, expectedCents) : await payWithLink(url, expectedCents, offer);
  if (paid.status !== 200) {
    const refunded = /"refunded"\s*:\s*true/.test(paid.body) ? " (gateway reports a refund)" : "";
    throw new PaidRequestFailed(`gateway answered HTTP ${paid.status} after payment${refunded}: ${excerpt(paid.body)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(paid.body);
  } catch {
    throw new PaidRequestFailed(`paid response is not JSON: ${excerpt(paid.body)}`);
  }
  const grant = isRecord(parsed) && isPurchaseGrant(parsed.grant) ? parsed.grant : parsed;
  if (!isPurchaseGrant(grant)) throw new PaidRequestFailed(`paid response is not a purchase grant: ${excerpt(paid.body)}`);

  await emit({ type: "buyer.step", step: "paid", detail: `${grant.paymentIntentId} · worker ${grant.workerSandboxId}` });
  return { grant, receiptReference: receiptReference(paid.receiptHeader), amountUsd };
}
