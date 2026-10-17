import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { PolygraphEvent } from "@polygraph/core";

const CAPACITY = 500;
const REPLAY = 200;
const HEARTBEAT_MS = 15_000;

interface StoredEvent {
  id: number;
  event: PolygraphEvent;
}

type Listener = (stored: StoredEvent) => void;

const buffer: StoredEvent[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function append(event: PolygraphEvent): void {
  const stored = { id: nextId++, event };
  buffer.push(stored);
  if (buffer.length > CAPACITY) buffer.shift();
  for (const listener of listeners) listener(stored);
}

type Payload<E> = E extends { ts: string } ? Omit<E, "ts"> : never;

/** Records an event that originates in the gateway itself. */
export function publish(event: Payload<PolygraphEvent>): void {
  append({ ...event, ts: new Date().toISOString() } as PolygraphEvent);
}

/** Loose check: agents own their payload shapes, the feed only needs a type and a timestamp. */
function parseIncoming(body: unknown): PolygraphEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.type !== "string" || !/^[a-z]+\.[a-z_]+$/.test(candidate.type)) return null;
  const ts = typeof candidate.ts === "string" && !Number.isNaN(Date.parse(candidate.ts)) ? candidate.ts : new Date().toISOString();
  return { ...candidate, ts } as PolygraphEvent;
}

function replayFrom(lastEventId: string | undefined): StoredEvent[] {
  const lastId = lastEventId === undefined ? NaN : Number(lastEventId);
  if (Number.isInteger(lastId)) return buffer.filter((stored) => stored.id > lastId);
  return buffer.slice(-REPLAY);
}

export function registerEventRoutes(app: Hono): void {
  app.post("/events", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const event = parseIncoming(body);
    if (!event) return c.json({ error: "event needs a string `type` such as \"buyer.step\"" }, 400);
    append(event);
    return c.json({ ok: true }, 202);
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      // Writes are chained so live events never overtake the replay or each other.
      let pending = Promise.resolve();
      const send = (stored: StoredEvent) => {
        pending = pending
          .then(() => stream.writeSSE({ id: String(stored.id), event: stored.event.type, data: JSON.stringify(stored.event) }))
          .catch(() => stream.abort());
      };

      for (const stored of replayFrom(c.req.header("last-event-id"))) send(stored);
      listeners.add(send);
      const heartbeat = setInterval(() => {
        pending = pending.then(() => stream.write(": keep-alive\n\n")).then(() => undefined, () => stream.abort());
      }, HEARTBEAT_MS);

      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      listeners.delete(send);
    }),
  );
}
