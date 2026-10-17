import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { registerEventRoutes } from "./events.js";
import { registerInspectRoutes } from "./inspect.js";
import { handleShutdownSignals, startBackgroundWork } from "./lifecycle.js";
import { registerOfferRoutes } from "./offers.js";
import { pooledWorkerIds } from "./pool.js";
import { registerPublishRoutes } from "./publish.js";
import { registerPurchaseRoutes } from "./purchase.js";

const app = new Hono();
const startedAt = Date.now();

app.get("/health", (c) =>
  c.json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), warmWorkers: pooledWorkerIds().size, poolSizePerOffer: config.poolSize }),
);

registerEventRoutes(app);
registerOfferRoutes(app);
registerPublishRoutes(app);
registerInspectRoutes(app);
registerPurchaseRoutes(app);
registerDiscoveryRoutes(app);

app.use("/*", serveStatic({ root: config.webRoot }));

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[gateway] ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
  return c.json({ error: "internal error" }, 500);
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Polygraph gateway listening on http://localhost:${info.port}, keeping ${config.poolSize} warm worker(s) per offer`);
});
handleShutdownSignals(() => server.close());
startBackgroundWork();
