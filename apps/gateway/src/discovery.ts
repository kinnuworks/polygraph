import type { Context, Hono } from "hono";
import { generate } from "mppx/discovery";
import { config } from "./config.js";
import { llmsTxt } from "./llms.js";
import { chargeCard, mppx } from "./payments.js";
import { PURCHASE_SECRET_HEADER } from "./purchase.js";

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
  required: ["purchaseId", "offerId", "workerSandboxId", "workerToken", "platformUrl", "paymentIntentId", "expiresAt", "purchaseSecret"],
  properties: {
    purchaseId: { type: "string" },
    offerId: { type: "string" },
    workerSandboxId: { type: "string", description: "Worker forked from the offer's parent for this purchase only." },
    workerToken: { type: "string", description: "CreateOS access token scoped to that worker." },
    platformUrl: { type: "string" },
    paymentIntentId: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    purchaseSecret: { type: "string", description: `Send as the ${PURCHASE_SECRET_HEADER} header to refund and done. Returned only here.` },
  },
};

const secretHeader = { name: PURCHASE_SECRET_HEADER, in: "header", required: true, description: "purchaseSecret from the purchase grant", schema: { type: "string" } };

const checksSchema = {
  type: "array",
  description: "The gateway's own checks of the worker, made with the owner key",
  items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, status: { enum: ["pass", "fail"] }, detail: { type: "string" } } },
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
      summary: "Get a short-lived CreateOS token for the offer's paused parent sandbox, to check its egress and status before paying. Revoked about 60 s after it is issued; the next inspect replaces it.",
      parameters: [offerId],
      responses: {
        "200": {
          description: "Inspection token",
          ...json({
            type: "object",
            properties: {
              parentSandboxId: { type: "string" },
              token: { type: "string" },
              platformUrl: { type: "string" },
              expiresAt: { type: "string", format: "date-time", description: "The token is revoked about this time, or earlier if another inspect of the same offer replaces it." },
            },
          }),
        },
        "404": { description: "No such offer" },
        "429": { description: "Rate limited, per client address and per offer; see Retry-After" },
        "502": { description: "CreateOS did not issue a token" },
      },
    },
  },
  "/purchases/{id}/refund": {
    post: {
      summary:
        "Ask for a refund. The gateway re-checks the worker's lineage, egress and tool digest itself and refunds only if one fails and no job input has been uploaded; the worker is then destroyed.",
      parameters: [purchaseId, secretHeader],
      requestBody: { required: false, ...json({ type: "object", properties: { reason: { type: "string" } } }) },
      responses: {
        "200": { description: "A check failed; refunded", ...json({ type: "object", properties: { refunded: { const: true }, refundId: { type: "string" }, checks: checksSchema } }) },
        "401": { description: "Missing or wrong purchase secret" },
        "404": { description: "No such purchase" },
        "409": { description: "Not refunded: every check passed, a job already started, or the purchase is not active", ...json({ type: "object", properties: { refunded: { const: false }, error: { type: "string" }, checks: checksSchema } }) },
        "502": { description: "The worker could not be checked, or Stripe refused the refund" },
      },
    },
  },
  "/purchases/{id}/done": {
    post: {
      summary: "Destroy the purchase's worker after the job",
      parameters: [purchaseId, secretHeader],
      responses: { "200": { description: "Worker destroyed" }, "401": { description: "Missing or wrong purchase secret" }, "404": { description: "No such purchase" } },
    },
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

function buildDocument(baseUrl: string): Record<string, unknown> {
  const doc = generate(mppx, {
    info: { title: "Polygraph gateway", version: "0.1.0" },
    serviceInfo: {
      categories: ["compute", "documents"],
      docs: { homepage: baseUrl, llms: `${baseUrl}/llms.txt` },
    },
    routes: [
      {
        handler: chargeCard({ amount: config.minPriceUsd.toFixed(2), description: "One job in a fresh worker forked from the offer's verified parent sandbox" }),
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
    "503": { description: "The worker did not start in time; the payment was refunded and the worker is kept for a retry after Retry-After" },
  };
  return { ...doc, servers: [{ url: baseUrl }], paths: { ...freeRoutes, ...paths } };
}

const HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * The base URL agents should use: POLYGRAPH_GATEWAY_URL when set, otherwise the scheme and host the
 * request came in on (X-Forwarded-Proto and X-Forwarded-Host first, as set by a TLS proxy). A spoofed
 * header only changes the document returned to that caller, and hosts are checked so it cannot inject text.
 */
function baseUrlFor(c: Context): string {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : url.protocol.slice(0, -1);
  const host = [forwardedHost, c.req.header("host")].find((h): h is string => !!h && HOST.test(h)) ?? url.host;
  return `${proto}://${host}`;
}

/** Documents are built once per base URL; there are only ever a few. */
const cache = new Map<string, { openapi: string; llms: string }>();

function documentsFor(baseUrl: string): { openapi: string; llms: string } {
  let docs = cache.get(baseUrl);
  if (!docs) {
    docs = { openapi: JSON.stringify(buildDocument(baseUrl)), llms: llmsTxt(baseUrl) };
    if (cache.size < 20) cache.set(baseUrl, docs);
  }
  return docs;
}

export function registerDiscoveryRoutes(app: Hono): void {
  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Vary", "Host, X-Forwarded-Host, X-Forwarded-Proto");
    return c.body(documentsFor(baseUrlFor(c)).openapi, 200, { "Content-Type": "application/json" });
  });
  app.get("/llms.txt", (c) => {
    c.header("Vary", "Host, X-Forwarded-Host, X-Forwarded-Proto");
    return c.text(documentsFor(baseUrlFor(c)).llms);
  });
}
