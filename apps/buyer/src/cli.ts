import { resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: npm run buyer -- --file <document.docx> [--gateway URL] [--pay test|link] [--out DIR]

  --file     document to convert
  --gateway  Polygraph gateway (default: $POLYGRAPH_GATEWAY_URL or http://localhost:4242)
  --pay      test: Stripe test card through a shared payment token (default)
             link: Link wallet via @stripe/link-cli, approved on your phone
  --out      where the PDF and its receipt are written (default: data/buyer)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    gateway: { type: "string" },
    pay: { type: "string", default: "test" },
    out: { type: "string", default: "data/buyer" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.file) fail("Missing --file.");
const pay = values.pay;
if (pay !== "test" && pay !== "link") fail(`--pay must be "test" or "link", got "${pay}".`);

const gateway = (values.gateway ?? process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242").replace(/\/+$/, "");
// The core event emitter reads the gateway URL when it is first imported, so set it before loading the agent.
process.env.POLYGRAPH_GATEWAY_URL = gateway;
const { run } = await import("./run.js");

try {
  const completed = await run({ gateway, file: resolve(values.file), pay, outDir: resolve(values.out) });
  // Keep-alive sockets from fetch can hold the process open, so exit explicitly.
  process.exit(completed ? 0 : 1);
} catch (err) {
  console.error(`buyer stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
