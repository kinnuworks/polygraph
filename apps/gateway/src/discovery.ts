import type { Hono } from "hono";
import { generate } from "mppx/discovery";
import { config } from "./config.js";
import { llmsTxt } from "./llms.js";
import { chargeCard, mppx } from "./payments.js";

type Operation = Record<string, unknown>;

const json = (schema: Record<string, unknown>) => ({ content: { "application/json": { schema } } });

const idParam = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } });

const offerSchema = {
  type: "object",
  description: "A signed offer: the seller's manifest, a compact EdDSA JWS over its canonical JSON, and the seller's public key as a JWK.",
  required: ["manifest", "jws", "publicKey"],
  properties: { manifest: { type: "object" }, jws: { type: "string" }, publicKey: { type: "object" } },
};

const grantSchema = {
  type: "object",
  required: ["purchaseId", "offerId", "workerSandboxId", "workerToken", "platformUrl", "paymentIntentId", "expiresAt"],
  properties: {
    purchaseId: { type: "string" },
    offerId: { type: "string" },
    workerSandboxId: { type: "string", description: "Worker forked from the offer's parent for this purchase only." },
    workerToken: { type: "string", description: "CreateOS access token scoped to that worker." },
    platformUrl: { type: "string" },
    paymentIntentId: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
  },
};

const offerId = idParam("id", "offerId from the manifest");
const purchaseId = idParam("id", "purchaseId from the purchase grant");

/** Routes that need no payment, described by hand. The paid route comes from mppx so its x-payment-info matches the live challenge. */
const freeRoutes: Record<string, Record<string, Operation>> = {
  "/offers": {
    get: { summary: "List signed offers", responses: { "200": { description: "Array of signed offers", ...json({ type: "array", items: offerSchema }) } } },
  },
  "/offers/{id}": {
    get: { summary: "Get one signed offer", parameters: [offerId], responses: { "200": { description: "Signed offer", ...json(offerSchema) }, "404": { description: "No such offer" } } },
  },
  "/offers/{id}/inspect": {
    get: {
      summary: "Get a short-lived CreateOS token for the offer's paused parent sandbox, to check its egress and status before paying",
      parameters: [offerId],
      responses: {
        "200": {
          description: "Inspection token",
          ...json({ type: "object", properties: { parentSandboxId: { type: "string" }, token: { type: "string" }, platformUrl: { type: "string" } } }),
        },
        "404": { description: "No such offer" },
        "502": { description: "CreateOS did not issue a token" },
      },
    },
  },
  "/purchases/{id}/refund": {
    post: {
      summary: "Refund an active purchase whose worker failed verification, and destroy the worker",
      parameters: [purchaseId],
      requestBody: { required: false, ...json({ type: "object", properties: { reason: { type: "string" } } }) },
      responses: { "200": { description: "Refunded" }, "404": { description: "No such purchase" }, "409": { description: "Purchase is not active" } },
    },
  },
  "/purchases/{id}/done": {
    post: { summary: "Destroy the purchase's worker after the job", parameters: [purchaseId], responses: { "200": { description: "Worker destroyed" }, "404": { description: "No such purchase" } } },
  },
  "/events": {
    get: { summary: "Server-Sent Events feed; replays the last 200 events, then streams", responses: { "200": { description: "text/event-stream" } } },
    post: {
      summary: "Add an event to the feed",
      requestBody: { required: true, ...json({ type: "object", required: ["type"], properties: { type: { type: "string" } } }) },
      responses: { "202": { description: "Accepted" }, "400": { description: "Not an event" } },
    },
  },
};

function buildDocument(): Record<string, unknown> {
  const doc = generate(mppx, {
    info: { title: "Polygraph gateway", version: "0.1.0" },
    serviceInfo: {
      categories: ["compute", "documents"],
      docs: { homepage: config.publicUrl, llms: `${config.publicUrl}/llms.txt` },
    },
    routes: [
      {
        handler: chargeCard({ amount: config.defaultPriceUsd, description: "One job in a fresh worker forked from the offer's verified parent sandbox" }),
        method: "POST",
        path: "/offers/{id}/buy",
        requestBody: { required: false, ...json({ type: "object", description: "No body is needed; the offer is named in the path." }) },
        summary: "Pay for one job and receive a fresh worker forked from the offer's parent sandbox. The amount is the offer's priceUsd; the 402 challenge is authoritative.",
      },
    ],
  });

  const paths = doc.paths as Record<string, Record<string, Operation>>;
  const buy = paths["/offers/{id}/buy"]!.post!;
  buy.parameters = [offerId];
  buy.responses = {
    ...(buy.responses as Operation),
    "200": { description: "Purchase grant, with a Payment-Receipt header", ...json(grantSchema) },
    "404": { description: "No such offer" },
    "502": { description: "The worker could not be created; the payment was refunded" },
  };
  return { ...doc, servers: [{ url: config.publicUrl }], paths: { ...freeRoutes, ...paths } };
}

export function registerDiscoveryRoutes(app: Hono): void {
  const document = JSON.stringify(buildDocument());
  const guide = llmsTxt(config.publicUrl);

  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.body(document, 200, { "Content-Type": "application/json" });
  });
  app.get("/llms.txt", (c) => c.text(guide));
}
