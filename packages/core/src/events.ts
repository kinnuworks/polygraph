import type { PolygraphEvent } from "./types.js";

type Payload<E> = E extends { ts: string } ? Omit<E, "ts"> : never;

/** One readable terminal line per event, so a run is easy to follow without the dashboard. */
export function describe(event: PolygraphEvent): string {
  switch (event.type) {
    case "seller.step":
    case "buyer.step":
      return event.detail ? `${event.step} · ${event.detail}` : event.step;
    case "seller.test":
      return `tests: ${event.passed} passed, ${event.failed} failed`;
    case "seller.patch":
      return `patched ${event.file}`;
    case "seller.attack":
      return `${event.attack}: ${event.status}${event.detail ? ` · ${event.detail}` : ""}`;
    case "offer.published":
      return `published ${event.offer.manifest.offerId} (${event.offer.manifest.name})`;
    case "buyer.check":
      return `${event.check.status.toUpperCase()} ${event.check.label}${event.check.detail ? ` · ${event.check.detail}` : ""}`;
    case "buyer.refused":
      return `REFUSED ${event.offerId} · ${event.reason}`;
    case "payment.created":
      return `paid $${event.amountUsd} · ${event.paymentIntentId}`;
    case "payment.refunded":
      return `refunded ${event.paymentIntentId} · ${event.reason}`;
    case "worker.forked":
      return `worker ${event.workerSandboxId} ready in ${event.ms} ms`;
    case "worker.destroyed":
      return `worker ${event.workerSandboxId} destroyed`;
    case "job.completed":
      return `job done · output ${event.receipt.outputSha256.slice(0, 12)}`;
  }
}

/** Sends an event to the gateway's live feed and mirrors it to the terminal. Never throws. */
export async function emit(event: Payload<PolygraphEvent>): Promise<void> {
  const full = { ...event, ts: new Date().toISOString() } as PolygraphEvent;
  console.log(`[${full.type}] ${describe(full)}`);
  // Read at call time so a CLI can set the gateway URL after this module loads.
  const gateway = process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242";
  try {
    await fetch(`${gateway}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(full),
    });
  } catch {
    /* the dashboard is optional; agents keep working without it */
  }
}
