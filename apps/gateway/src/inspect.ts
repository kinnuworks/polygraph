import type { Hono } from "hono";
import { config } from "./config.js";
import { getOffer } from "./offers.js";
import { clientAddress, RateLimiter } from "./ratelimit.js";
import { issueAccessToken, revokeAccessToken } from "./sandbox.js";

interface LiveToken {
  revokeAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Each inspect gets a freshly rotated token, which ends the previous one, since CreateOS keeps one token
 * per sandbox. The current token is revoked a fixed time after it was issued.
 */
const live = new Map<string, LiveToken>();
const queues = new Map<string, Promise<unknown>>();

/** Runs token operations for one parent one at a time, so a revoke never races an issue. */
function serialized<T>(parentSandboxId: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(parentSandboxId) ?? Promise.resolve()).then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(parentSandboxId, settled);
  void settled.then(() => {
    if (queues.get(parentSandboxId) === settled) queues.delete(parentSandboxId);
  });
  return run;
}

/** Revokes the parent's token once it is due; an inspect queued just before the timer fired pushes the due time back. */
function revoke(parentSandboxId: string, force = false): Promise<void> {
  return serialized(parentSandboxId, async () => {
    const entry = live.get(parentSandboxId);
    if (!entry || (!force && Date.now() < entry.revokeAt)) return;
    clearTimeout(entry.timer);
    live.delete(parentSandboxId);
    try {
      await revokeAccessToken(parentSandboxId);
      console.log(`[inspect] revoked the inspect token for ${parentSandboxId}`);
    } catch (err) {
      console.error(`[inspect] ${(err as Error).message}`);
    }
  });
}

/** Issues a parent token on the same terms as GET /offers/:id/inspect: rotated in, revoked after the TTL. */
export function handOut(parentSandboxId: string): Promise<{ token: string; expiresAt: string }> {
  return serialized(parentSandboxId, async () => {
    const token = await issueAccessToken(parentSandboxId);
    const previous = live.get(parentSandboxId);
    if (previous) clearTimeout(previous.timer);
    const revokeAt = Date.now() + config.inspectTokenTtlMs;
    const timer = setTimeout(() => void revoke(parentSandboxId), config.inspectTokenTtlMs);
    timer.unref();
    live.set(parentSandboxId, { revokeAt, timer });
    return { token, expiresAt: new Date(revokeAt).toISOString() };
  });
}

/** Revokes every inspect token still live, for shutdown. */
export async function revokeInspectTokens(): Promise<void> {
  await Promise.all([...live.keys()].map((parentSandboxId) => revoke(parentSandboxId, true)));
}

/** Every inspect rotates the parent's token and so cuts off the previous holder; these limits keep that from being abused. */
const perClient = new RateLimiter(config.inspectLimits.perClient.burst, config.inspectLimits.perClient.refillMs);
const perOffer = new RateLimiter(config.inspectLimits.perOffer.burst, config.inspectLimits.perOffer.refillMs);

export function registerInspectRoutes(app: Hono): void {
  app.get("/offers/:id/inspect", async (c) => {
    const retryClient = perClient.take(clientAddress(c));
    if (retryClient > 0) {
      c.header("Retry-After", String(retryClient));
      return c.json({ error: `too many inspect requests from this address; retry in ${retryClient} s` }, 429);
    }
    const offer = await getOffer(c.req.param("id"));
    if (!offer) return c.json({ error: "offer not found" }, 404);
    const retryOffer = perOffer.take(offer.manifest.offerId);
    if (retryOffer > 0) {
      c.header("Retry-After", String(retryOffer));
      return c.json({ error: `too many inspect requests for this offer; retry in ${retryOffer} s` }, 429);
    }
    const { parentSandboxId } = offer.manifest;
    try {
      const { token, expiresAt } = await handOut(parentSandboxId);
      return c.json({ parentSandboxId, token, platformUrl: config.createos.baseUrl, expiresAt });
    } catch (err) {
      console.error(`[inspect] ${parentSandboxId}: ${(err as Error).message}`);
      return c.json({ error: "could not get an inspection token from CreateOS for this offer's parent sandbox" }, 502);
    }
  });
}
