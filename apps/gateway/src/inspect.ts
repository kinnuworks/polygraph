import type { Hono } from "hono";
import { config } from "./config.js";
import { getOffer } from "./offers.js";
import { mintAccessToken } from "./sandbox.js";

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, Promise<CachedToken>>();

/** Shares one token per parent for a few minutes, so a burst of buyers does not mint one each. */
function parentToken(parentSandboxId: string): Promise<CachedToken> {
  const cached = cache.get(parentSandboxId);
  if (cached) return cached;
  const minted = mintAccessToken(parentSandboxId).then((token) => ({ token, expiresAt: Date.now() + config.inspectTokenTtlMs }));
  cache.set(parentSandboxId, minted);
  minted.then(
    ({ expiresAt }) => setTimeout(() => cache.delete(parentSandboxId), expiresAt - Date.now()).unref(),
    () => cache.delete(parentSandboxId),
  );
  return minted;
}

export function registerInspectRoutes(app: Hono): void {
  app.get("/offers/:id/inspect", async (c) => {
    const offer = await getOffer(c.req.param("id"));
    if (!offer) return c.json({ error: "offer not found" }, 404);
    const { parentSandboxId } = offer.manifest;
    try {
      const { token } = await parentToken(parentSandboxId);
      return c.json({ parentSandboxId, token, platformUrl: config.createos.baseUrl });
    } catch (err) {
      console.error(`[inspect] ${parentSandboxId}: ${(err as Error).message}`);
      return c.json({ error: "could not get an inspection token from CreateOS for this offer's parent sandbox" }, 502);
    }
  });
}
