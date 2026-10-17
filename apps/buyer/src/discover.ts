import { emit, type SignedManifest } from "@polygraph/core";
import { getJson, getText, isRecord } from "./http.js";
import { centsToUsd, usdToCents } from "./money.js";

export interface Discovery {
  /** First line of /llms.txt, which names the service. */
  serviceTitle: string | null;
  /** Price advertised in /openapi.json for the paid route, in dollars. */
  listedPriceUsd: string | null;
  /** Well-formed offers, cheapest first. */
  offers: SignedManifest[];
  /** Entries in /offers that were not signed manifests. */
  malformed: number;
}

function isSignedManifest(value: unknown): value is SignedManifest {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.publicKey)) return false;
  const m = value.manifest;
  return (
    typeof value.jws === "string" &&
    typeof m.offerId === "string" &&
    typeof m.parentSandboxId === "string" &&
    typeof m.artifactDigest === "string" &&
    typeof m.priceUsd === "string" &&
    Array.isArray(m.egress) &&
    m.egress.every((rule) => typeof rule === "string")
  );
}

/** "50" (smallest unit, as mppx lists it) or "0.50" (plain dollars) to dollars. */
function dollars(amount: unknown): string | null {
  if (typeof amount !== "string") return null;
  if (/^\d+$/.test(amount)) return centsToUsd(Number(amount));
  if (/^\d+\.\d{1,2}$/.test(amount)) return centsToUsd(usdToCents(amount));
  return null;
}

/**
 * Reads the amount of the first paid operation, either directly on `x-payment-info` or on its
 * first entry in `offers`. Discovery is advisory; the 402 challenge decides what is charged.
 */
function listedPrice(openapi: unknown): string | null {
  if (!isRecord(openapi) || !isRecord(openapi.paths)) return null;
  for (const operations of Object.values(openapi.paths)) {
    if (!isRecord(operations)) continue;
    for (const operation of Object.values(operations)) {
      const info = isRecord(operation) ? operation["x-payment-info"] : undefined;
      if (!isRecord(info)) continue;
      const first = Array.isArray(info.offers) && isRecord(info.offers[0]) ? info.offers[0] : {};
      const price = dollars(info.amount) ?? dollars(first.amount);
      if (price) return price;
    }
  }
  return null;
}

async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

const priceOf = (offer: SignedManifest) => {
  try {
    return usdToCents(offer.manifest.priceUsd);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export async function discover(gateway: string): Promise<Discovery> {
  await emit({ type: "buyer.step", step: "discover", detail: `reading ${gateway}/llms.txt, /openapi.json and /offers` });

  const llms = await optional(() => getText(`${gateway}/llms.txt`));
  const openapi = await optional(() => getJson(`${gateway}/openapi.json`));
  const listing = await getJson(`${gateway}/offers`);
  const entries: unknown[] = Array.isArray(listing) ? listing : isRecord(listing) && Array.isArray(listing.offers) ? listing.offers : [];

  const offers = entries.filter(isSignedManifest).sort((a, b) => priceOf(a) - priceOf(b));
  const discovery: Discovery = {
    serviceTitle: llms?.split("\n").find((line) => line.trim())?.replace(/^#\s*/, "").trim() ?? null,
    listedPriceUsd: listedPrice(openapi),
    offers,
    malformed: entries.length - offers.length,
  };

  const price = discovery.listedPriceUsd ? `$${discovery.listedPriceUsd}` : "no listed price";
  const skipped = discovery.malformed ? `, ${discovery.malformed} malformed entries ignored` : "";
  await emit({
    type: "buyer.step",
    step: "discovered",
    detail: `${discovery.serviceTitle ?? "untitled service"} · ${price} · ${offers.length} offers${skipped}`,
  });
  return discovery;
}
