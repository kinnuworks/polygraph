import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { registerEventRoutes } from "./events.js";
import { registerInspectRoutes } from "./inspect.js";
import { registerOfferRoutes } from "./offers.js";
import { registerPurchaseRoutes } from "./purchase.js";

const app = new Hono();
const startedAt = Date.now();

app.get("/health", (c) => c.json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));

registerEventRoutes(app);
registerOfferRoutes(app);
registerInspectRoutes(app);
registerPurchaseRoutes(app);
registerDiscoveryRoutes(app);

app.use("/*", serveStatic({ root: config.webRoot }));

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[gateway] ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
  return c.json({ error: "internal error" }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Polygraph gateway listening on http://localhost:${info.port}`);
});
