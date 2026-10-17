import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { run } from "./run.js";

const USAGE = `Usage: npm run buyer -- --file <document.docx> [--gateway URL] [--pay test|link] [--mode worker|own] [--trust-seller] [--out DIR]

  --file          document to convert
  --gateway       Polygraph gateway (default: $POLYGRAPH_GATEWAY_URL or http://localhost:4242)
  --pay           test: Stripe test card through a shared payment token (default)
                  link: Link wallet via @stripe/link-cli, approved on your phone
  --mode          worker: run in the seller's verified worker (default)
                  own: copy the verified tool into a sandbox on your own CreateOS account
                  (BUYER_CREATEOS_SANDBOX_API_KEY, else CREATEOS_PLAN_API_KEY) and run it there
  --trust-seller  pin the seller's key for this gateway on first use (data/buyer/trusted-sellers.json)
  --out           where the PDF and its receipt are written (default: data/buyer)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    gateway: { type: "string" },
    pay: { type: "string", default: "test" },
    mode: { type: "string", default: "worker" },
    "trust-seller": { type: "boolean", default: false },
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
const mode = values.mode;
if (mode !== "worker" && mode !== "own") fail(`--mode must be "worker" or "own", got "${mode}".`);

const gateway = (values.gateway ?? process.env.POLYGRAPH_GATEWAY_URL ?? "http://localhost:4242").replace(/\/+$/, "");
// Events go to the same gateway the buyer is shopping at.
process.env.POLYGRAPH_GATEWAY_URL = gateway;

try {
  const completed = await run({
    gateway,
    file: resolve(values.file),
    pay,
    mode,
    trustSeller: values["trust-seller"],
    outDir: resolve(values.out),
  });
  // Keep-alive sockets from fetch can hold the process open, so exit explicitly.
  process.exit(completed ? 0 : 1);
} catch (err) {
  console.error(`buyer stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
