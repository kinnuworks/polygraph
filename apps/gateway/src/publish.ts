import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { verifyManifest } from "@polygraph/core";
import { config } from "./config.js";
import { publish } from "./events.js";
import { getOffer, isChargeable, isSignedManifest, OFFER_ID, publicView, removeOffer, storePublishedOffer } from "./offers.js";
import { syncPools } from "./pool.js";

/** Header that carries PUBLISH_TOKEN. */
export const PUBLISH_TOKEN_HEADER = "x-polygraph-publish-token";

const digest = (value: string) => createHash("sha256").update(value).digest();

function authorized(c: Context, expected: string): boolean {
  const presented = c.req.header(PUBLISH_TOKEN_HEADER);
  return presented !== undefined && timingSafeEqual(digest(presented), digest(expected));
}

/** Pools follow the offer list; refresh them now rather than at the next sweep. */
function refreshPools(): void {
  syncPools().catch((err) => console.error(`[publish] pool refresh failed: ${(err as Error).message}`));
}

/**
 * Lets the seller publish and withdraw offers on a running gateway, so the deployed list is not limited
 * to the files baked into the image. Disabled entirely (404) when PUBLISH_TOKEN is unset.
 */
export function registerPublishRoutes(app: Hono): void {
  const token = config.publishToken;
  if (!token) return;

  app.post("/offers", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    if (!authorized(c, token)) return c.json({ error: `missing or wrong ${PUBLISH_TOKEN_HEADER} header` }, 401);
    const body = (await c.req.json().catch(() => null)) as { offer?: unknown; foil?: unknown } | null;
    const offer = body?.offer;
    if (!isSignedManifest(offer)) return c.json({ error: "body must be { offer: SignedManifest, foil?: string }" }, 400);
    if (body?.foil !== undefined && (typeof body.foil !== "string" || body.foil.length === 0 || body.foil.length > 64)) {
      return c.json({ error: "foil, when given, must be a short non-empty string" }, 400);
    }
    const { offerId, priceUsd } = offer.manifest;
    if (!OFFER_ID.test(offerId)) return c.json({ error: "offerId may use letters, digits, - and _ only, up to 128 characters" }, 400);
    const signature = verifyManifest(offer);
    if (!signature.valid) return c.json({ error: `signature check failed: ${signature.reason}` }, 422);
    if (!isChargeable(priceUsd)) return c.json({ error: `priceUsd must be a dollar amount of at least ${config.minPriceUsd.toFixed(2)}` }, 422);

    await storePublishedOffer(offer, body?.foil !== undefined);
    const listed = (await getOffer(offerId)) !== null;
    // A hidden foil is not announced, so the feed never shows an offer the list does not.
    if (listed) publish({ type: "offer.published", offer: publicView(offer) });
    console.log(`[publish] stored ${offerId}${listed ? "" : " (not listed: hidden demo foil, or an older manifest than the baked one)"}`);
    refreshPools();
    return c.json({ offerId, listed }, 201);
  });

  app.delete("/offers/:id", async (c) => {
    if (!authorized(c, token)) return c.json({ error: `missing or wrong ${PUBLISH_TOKEN_HEADER} header` }, 401);
    const offerId = c.req.param("id");
    const wasListed = (await getOffer(offerId)) !== null;
    if (!OFFER_ID.test(offerId) || !(await removeOffer(offerId))) return c.json({ error: "offer not found" }, 404);
    if (wasListed) publish({ type: "offer.removed", offerId });
    console.log(`[publish] removed ${offerId}`);
    refreshPools();
    return c.json({ offerId, removed: true });
  });
}
