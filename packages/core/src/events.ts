import type { PolygraphEvent } from "./types.js";

const GATEWAY_URL = process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242";

type Payload<E> = E extends { ts: string } ? Omit<E, "ts"> : never;

/** Sends an event to the gateway's live feed and mirrors it to the terminal. Never throws. */
export async function emit(event: Payload<PolygraphEvent>): Promise<void> {
  const full = { ...event, ts: new Date().toISOString() } as PolygraphEvent;
  const label = "step" in full ? full.step : full.type;
  console.log(`[${full.type}] ${label}${"detail" in full && full.detail ? ` · ${full.detail}` : ""}`);
  try {
    await fetch(`${GATEWAY_URL}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(full),
    });
  } catch {
    /* the dashboard is optional; agents keep working without it */
  }
}
