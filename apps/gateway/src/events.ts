import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { PolygraphEvent } from "@polygraph/core";
import { config } from "./config.js";

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

function store(event: PolygraphEvent): StoredEvent {
  const stored = { id: nextId++, event };
  buffer.push(stored);
  if (buffer.length > CAPACITY) buffer.shift();
  return stored;
}

/** Live events (not the recorded replay), newest last, as kept in the history file. */
const history: PolygraphEvent[] = [];
/** Lines in the history file; it is rewritten from `history` once it holds twice CAPACITY. */
let logLines = 0;

function writeHistoryFile(): void {
  mkdirSync(dirname(config.eventsLogPath), { recursive: true });
  writeFileSync(config.eventsLogPath, history.map((event) => `${JSON.stringify(event)}\n`).join(""));
  logLines = history.length;
}

function persist(event: PolygraphEvent): void {
  history.push(event);
  if (history.length > CAPACITY) history.shift();
  try {
    if (logLines >= 2 * CAPACITY) {
      writeHistoryFile();
    } else {
      appendFileSync(config.eventsLogPath, `${JSON.stringify(event)}\n`);
      logLines++;
    }
  } catch (err) {
    console.error(`[events] could not write ${config.eventsLogPath}: ${(err as Error).message}`);
  }
}

function append(event: PolygraphEvent): void {
  const stored = store(event);
  persist(event);
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

/** Reads a JSON-lines file of events, skipping lines that are not events. Missing files read as empty. */
function readEventLines(path: string): PolygraphEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[events] could not read ${path}: ${(err as Error).message}`);
    return [];
  }
  const events: PolygraphEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: PolygraphEvent | null = null;
    try {
      event = parseIncoming(JSON.parse(line));
    } catch {
      /* counted below */
    }
    if (event) events.push(event);
    else skipped++;
  }
  if (skipped > 0) console.warn(`[events] skipped ${skipped} unreadable line(s) in ${path}`);
  return events;
}

/**
 * Fills the feed before the server starts: a recorded run baked into the deployment comes first, under a
 * marker so viewers know it is a replay, then the live history kept from before a restart.
 * History is compacted to the newest CAPACITY events, so the file stays small across restarts.
 */
function loadHistory(): void {
  const recorded = readEventLines(config.recordedEventsPath);
  if (recorded.length > 0) {
    const first = recorded[0]!.ts;
    store({ type: "seller.step", ts: first, step: "replay", detail: `recorded run from ${first}` });
    for (const event of recorded) store(event);
    console.log(`[events] replaying ${recorded.length} recorded event(s) from ${config.recordedEventsPath}`);
  }
  history.push(...readEventLines(config.eventsLogPath).slice(-CAPACITY));
  for (const event of history) store(event);
  if (history.length > 0) console.log(`[events] restored ${history.length} event(s) from ${config.eventsLogPath}`);
  try {
    writeHistoryFile();
  } catch (err) {
    console.error(`[events] could not write ${config.eventsLogPath}: ${(err as Error).message}`);
  }
}

loadHistory();

function replayFrom(lastEventId: string | undefined): StoredEvent[] {
  const lastId = lastEventId === undefined ? NaN : Number(lastEventId);
  if (Number.isInteger(lastId)) return buffer.filter((stored) => stored.id > lastId);
  return buffer.slice(-REPLAY);
}

export function registerEventRoutes(app: Hono): void {
  app.post("/events", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    // The feed is public to read; only our own agents may write to it when a token is configured.
    const expected = process.env.EVENTS_TOKEN;
    if (expected && c.req.header("x-polygraph-events-token") !== expected) {
      return c.json({ error: "missing or wrong events token" }, 401);
    }
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
