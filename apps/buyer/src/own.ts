import { dirname } from "node:path";
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import { ARTIFACT_DIGEST_COMMAND, emit, PLATFORM_URL, readPlatformView, TOOL_DIR, type CheckResult, type SignedManifest } from "@polygraph/core";
import type { Bundle } from "./bundle.js";
import { runJob, type JobResult } from "./job.js";
import { RemoteSandbox, shellQuote } from "./worker.js";

export interface OwnedRun {
  job: JobResult;
  sandboxId: string;
  checks: CheckResult[];
}

/** Largest shape the free CreateOS plan allows. */
const OWN_SHAPE = "s-2vcpu-2gb";
/** Same packages the seller installs in its parent image. */
const PACKAGES = ["libreoffice-writer-nogui", "libreoffice-calc-nogui", "libreoffice-impress-nogui", "python3-uno", "poppler-utils"];
/** Any non-empty egress list denies everything else; this one rule points at nothing. */
const DENY_ALL = ["127.0.0.1:9"];

/** The buyer's own CreateOS account key. It must not be the seller's, or nothing has changed. */
function buyerAccountKey(): { key: string; source: string } {
  const source = process.env.BUYER_CREATEOS_SANDBOX_API_KEY ? "BUYER_CREATEOS_SANDBOX_API_KEY" : "CREATEOS_PLAN_API_KEY";
  const key = process.env[source];
  if (!key) throw new Error("--mode own needs BUYER_CREATEOS_SANDBOX_API_KEY (or CREATEOS_PLAN_API_KEY) for the buyer's own CreateOS account");
  if (key === process.env.CREATEOS_SANDBOX_API_KEY) throw new Error(`${source} is the seller's account key; buyer-owned mode needs a separate account`);
  return { key, source };
}

/**
 * Runs the job on the buyer's own CreateOS account so the seller never sees the document: a fresh
 * sandbox gets LibreOffice while egress is open, is then locked to deny-all, receives the tool
 * bundle the buyer already hashed, and converts the document there. The sandbox is always destroyed.
 */
export async function runOwned(offer: SignedManifest, bundle: Bundle, inputPath: string, outDir: string): Promise<OwnedRun> {
  const { offerId, artifactDigest } = offer.manifest;
  const { key, source } = buyerAccountKey();
  const checks: CheckResult[] = [];
  const check = async (id: string, label: string, passed: boolean, detail: string) => {
    const result: CheckResult = { id, label, status: passed ? "pass" : "fail", detail };
    checks.push(result);
    await emit({ type: "buyer.check", offerId, check: result });
    if (!passed) throw new Error(`${label}: ${detail}`);
  };

  const client = new CreateosSandboxClient({ apiKey: key, baseUrl: PLATFORM_URL });
  await emit({ type: "buyer.step", step: "own-sandbox", detail: `creating a ${OWN_SHAPE} sandbox on the buyer's account (${source})` });
  const sandbox = await client.createSandbox({ shape: OWN_SHAPE, rootfs: "devbox:1" });
  const own = new RemoteSandbox(sandbox.id, key);
  try {
    await emit({ type: "buyer.step", step: "own-install", detail: `${sandbox.id} · apt-get install ${PACKAGES.join(" ")} (egress open)` });
    const started = Date.now();
    const install = await own.sh(
      `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq --no-install-recommends ${PACKAGES.join(" ")} >/dev/null 2>&1 && command -v soffice`,
      600_000,
    );
    await check("own-install", "LibreOffice installed from Ubuntu packages", install.exitCode === 0, `exit ${install.exitCode} in ${Math.round((Date.now() - started) / 1000)} s · ${install.stdout.trim() || install.stderr.trim().slice(0, 120)}`);

    await sandbox.setEgress(DENY_ALL);
    const view = (await readPlatformView(sandbox.id, key)).view;
    const egress = view?.egress ?? [];
    await check("own-egress", "Your sandbox is locked to deny-all", JSON.stringify(egress) === JSON.stringify(DENY_ALL), `CreateOS egress [${egress.join(", ")}]`);
    const probe = await own.sh("curl -sS -m 6 -o /dev/null https://pypi.org/ 2>&1; echo \"exit=$?\"");
    const exit = /exit=(\d+)/.exec(probe.stdout)?.[1] ?? "?";
    await check("own-offline", "Your sandbox cannot reach the internet", exit !== "0" && exit !== "127", `curl https://pypi.org/ exit ${exit}`);

    await emit({ type: "buyer.step", step: "own-bundle", detail: `copying ${bundle.size} verified tool files into ${sandbox.id}` });
    const dirs = [...new Set([...bundle.keys()].map((path) => dirname(`${TOOL_DIR}/${path.slice(2)}`)))];
    await own.sh(`mkdir -p ${dirs.map(shellQuote).join(" ")}`);
    for (const [path, bytes] of bundle) await own.upload(`${TOOL_DIR}/${path.slice(2)}`, new Uint8Array(bytes));
    const digest = (await own.sh(ARTIFACT_DIGEST_COMMAND)).stdout.trim();
    await check("own-digest", "Tool in your sandbox matches the signed digest", digest === artifactDigest, `signed ${artifactDigest.slice(0, 16)}… · yours ${digest.slice(0, 16)}…`);

    const job = await runJob(own, offerId, inputPath, outDir);
    return { job, sandboxId: sandbox.id, checks: [...checks, ...job.checks] };
  } finally {
    try {
      await sandbox.destroy();
      await emit({ type: "buyer.step", step: "own-destroyed", detail: sandbox.id });
    } catch (err) {
      await emit({ type: "buyer.step", step: "own-destroy-failed", detail: `${sandbox.id} · ${(err as Error).message}` });
    }
  }
}
