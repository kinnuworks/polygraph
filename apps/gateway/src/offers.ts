import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import type { SignedManifest } from "@polygraph/core";
import { config } from "./config.js";

/**
 * Offers come from two places: files baked into the deployment (data/offers, with an optional
 * <id>.foil.json sidecar) and offers published at runtime through the publish API (.runtime/offers).
 * They are merged when read; for an id present in both, the newer manifest wins. A foil flag is only
 * ever used to filter, never served.
 */

export const OFFER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A runtime record: a published offer, or a tombstone that hides a baked offer of the same id. */
type PublishedRecord = { offer: SignedManifest; foil: boolean; publishedAt: string } | { removed: true; removedAt: string };

interface Candidate {
  offer: SignedManifest;
  foil: boolean;
}

export function isSignedManifest(value: unknown): value is SignedManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const m = v.manifest as Record<string, unknown> | undefined;
  return (
    typeof v.jws === "string" &&
    typeof v.publicKey === "object" &&
    v.publicKey !== null &&
    typeof m === "object" &&
    m !== null &&
    typeof m.offerId === "string" &&
    typeof m.parentSandboxId === "string" &&
    typeof m.artifactDigest === "string" &&
    Array.isArray(m.egress)
  );
}

/** Rebuilds the object field by field so nothing beyond the signed offer (such as a foil label) is ever served. */
export function publicView(offer: SignedManifest): SignedManifest {
  return { manifest: offer.manifest, jws: offer.jws, publicKey: offer.publicKey };
}

const PRICE = /^\d{1,4}(\.\d{1,2})?$/;

/** Offers that cannot be charged by card are kept off the list rather than repriced. */
export const isChargeable = (priceUsd: unknown): priceUsd is string =>
  typeof priceUsd === "string" && PRICE.test(priceUsd) && Number(priceUsd) >= config.minPriceUsd;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[offers] skipping unreadable ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

async function readBaked(offerId: string): Promise<Candidate | null> {
  const path = join(config.offersDir, `${offerId}.json`);
  const parsed = await readJson(path);
  if (parsed === undefined) return null;
  if (!isSignedManifest(parsed)) {
    console.warn(`[offers] skipping ${path}: not a signed manifest`);
    return null;
  }
  // Only the sidecar's existence is read, never its label.
  return { offer: publicView(parsed), foil: await exists(join(config.offersDir, `${offerId}.foil.json`)) };
}

async function readPublished(offerId: string): Promise<PublishedRecord | null> {
  const parsed = (await readJson(join(config.publishedOffersDir, `${offerId}.json`))) as PublishedRecord | undefined;
  if (!parsed) return null;
  if ("removed" in parsed) return parsed;
  return isSignedManifest(parsed.offer) ? { offer: publicView(parsed.offer), foil: parsed.foil === true, publishedAt: parsed.publishedAt } : null;
}

const createdAt = (offer: SignedManifest) => Date.parse(offer.manifest.createdAt) || 0;

async function resolve(offerId: string): Promise<Candidate | null> {
  const [baked, published] = await Promise.all([readBaked(offerId), readPublished(offerId)]);
  if (published && "removed" in published) return null;
  const candidates = [published, baked].filter((c): c is Candidate => c !== null);
  // Published first, so it wins a tie.
  const winner = candidates.reduce<Candidate | null>((best, c) => (!best || createdAt(c.offer) > createdAt(best.offer) ? c : best), null);
  return winner && winner.offer.manifest.offerId === offerId ? winner : null;
}

const skipped = new Set<string>();

/** Logs why an offer is hidden, once per offer and reason, so polling clients do not flood the log. */
function skip(offerId: string, why: string): null {
  const key = `${offerId}:${why}`;
  if (!skipped.has(key)) {
    skipped.add(key);
    console.warn(`[offers] not listing ${offerId}: ${why}`);
  }
  return null;
}

export async function getOffer(offerId: string): Promise<SignedManifest | null> {
  if (!OFFER_ID.test(offerId)) return null;
  const found = await resolve(offerId);
  if (!found) return null;
  if (!isChargeable(found.offer.manifest.priceUsd)) {
    return skip(offerId, `price ${JSON.stringify(found.offer.manifest.priceUsd)} is below the $${config.minPriceUsd.toFixed(2)} card minimum or not a dollar amount`);
  }
  if (found.foil && !config.demoFoils) return skip(offerId, "demo foil, and DEMO_FOILS is not 1");
  return found.offer;
}

async function idsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".foil.json")).map((name) => name.slice(0, -".json".length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function listOffers(): Promise<SignedManifest[]> {
  const ids = [...new Set([...(await idsIn(config.offersDir)), ...(await idsIn(config.publishedOffersDir))])].sort();
  const offers = await Promise.all(ids.map(getOffer));
  return offers.filter((offer): offer is SignedManifest => offer !== null);
}

async function writePublished(offerId: string, record: PublishedRecord): Promise<void> {
  await mkdir(config.publishedOffersDir, { recursive: true });
  const path = join(config.publishedOffersDir, `${offerId}.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(record, null, 1), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** Stores an offer published at runtime. The caller has checked the signature and price. */
export async function storePublishedOffer(offer: SignedManifest, foil: boolean): Promise<void> {
  await writePublished(offer.manifest.offerId, { offer: publicView(offer), foil, publishedAt: new Date().toISOString() });
}

/** Hides an offer, whether baked or published, until it is published again. Returns false when there was nothing to remove. */
export async function removeOffer(offerId: string): Promise<boolean> {
  if (!(await resolve(offerId))) return false;
  await writePublished(offerId, { removed: true, removedAt: new Date().toISOString() });
  return true;
}

export function registerOfferRoutes(app: Hono): void {
  app.get("/offers", async (c) => c.json(await listOffers()));

  app.get("/offers/:id", async (c) => {
    const offer = await getOffer(c.req.param("id"));
    return offer ? c.json(offer) : c.json({ error: "offer not found" }, 404);
  });
}
