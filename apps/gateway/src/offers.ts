import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import type { SignedManifest } from "@polygraph/core";
import { config } from "./config.js";

const OFFER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isSignedManifest(value: unknown): value is SignedManifest {
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
    typeof m.artifactDigest === "string"
  );
}

/** Rebuilds the object field by field so nothing beyond the signed offer (such as a foil label) is ever served. */
function publicView(offer: SignedManifest): SignedManifest {
  return { manifest: offer.manifest, jws: offer.jws, publicKey: offer.publicKey };
}

async function readOfferFile(path: string): Promise<SignedManifest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[offers] skipping unreadable ${path}: ${(err as Error).message}`);
    return null;
  }
  if (!isSignedManifest(parsed)) {
    console.warn(`[offers] skipping ${path}: not a signed manifest`);
    return null;
  }
  return publicView(parsed);
}

export async function getOffer(offerId: string): Promise<SignedManifest | null> {
  if (!OFFER_ID.test(offerId)) return null;
  const offer = await readOfferFile(join(config.offersDir, `${offerId}.json`));
  return offer && offer.manifest.offerId === offerId ? offer : null;
}

export async function listOffers(): Promise<SignedManifest[]> {
  let names: string[];
  try {
    names = await readdir(config.offersDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const ids = names
    .filter((name) => name.endsWith(".json") && !name.endsWith(".foil.json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const offers = await Promise.all(ids.map(getOffer));
  return offers.filter((offer): offer is SignedManifest => offer !== null);
}

export function registerOfferRoutes(app: Hono): void {
  app.get("/offers", async (c) => c.json(await listOffers()));

  app.get("/offers/:id", async (c) => {
    const offer = await getOffer(c.req.param("id"));
    return offer ? c.json(offer) : c.json({ error: "offer not found" }, 404);
  });
}
