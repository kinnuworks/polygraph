import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, acceptanceSuiteDigest, acceptanceSuiteDigestCommand, emit, type AcceptanceRecord, type CheckResult } from "@polygraph/core";
import { ENGINEER_SYSTEM, testAndFix, type Workspace } from "./build.js";
import { HARDEN_BRIEF } from "./harden.js";
import { askForFiles } from "./llm.js";
import { sh, tail } from "./sandbox.js";

/*
 * The acceptance suite is written by hand, checked into the repo and uploaded outside TOOL_DIR, so it
 * never affects the artifact digest. The agent never sees its source: on failure it gets only the test
 * names, assertion messages and captured output.
 */

const LOCAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../acceptance");
const REMOTE_DIR = "/opt/acceptance";
const REPORT = "/tmp/acceptance.xml";
const MAX_ROUNDS = 6;
const AGENT_RUNS_PER_ROUND = 3;

interface CaseResult {
  test: string;
  outcome: "passed" | "failed" | "skipped";
  message: string;
  captured: string;
}

interface AcceptanceRun {
  cases: CaseResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

export interface SealedSuite {
  digest: string;
  files: { path: string; content: Buffer }[];
}

/**
 * Reads the suite from the repo and fixes its digest. The seller does this before the agent writes any
 * code, and the same files are what get uploaded and run.
 */
export async function sealSuite(): Promise<SealedSuite> {
  const names = (await readdir(LOCAL_DIR)).filter((name) => name.endsWith(".py")).sort();
  const files = await Promise.all(names.map(async (path) => ({ path, content: await readFile(join(LOCAL_DIR, path)) })));
  return { digest: acceptanceSuiteDigest(files), files };
}

/** Uploads the sealed files and confirms, from inside the sandbox, that they hash to the sealed digest. */
async function upload(sandbox: Sandbox, suite: SealedSuite): Promise<void> {
  for (const file of suite.files) await sandbox.files.upload(`${REMOTE_DIR}/${file.path}`, new Uint8Array(file.content));
  const remote = (await sh(sandbox, acceptanceSuiteDigestCommand(REMOTE_DIR))).stdout.trim();
  if (remote !== suite.digest) throw new Error(`acceptance suite in the sandbox hashes to ${remote}, expected ${suite.digest}`);
}

async function runAcceptance(sandbox: Sandbox): Promise<AcceptanceRun> {
  const run = await sh(
    sandbox,
    `cd ${REMOTE_DIR} && rm -f ${REPORT} && PYTHONDONTWRITEBYTECODE=1 timeout 900 python3 -m pytest -q -p no:cacheprovider --tb=no` +
      ` --junitxml=${REPORT} -o junit_logging=all >/dev/null 2>&1; python3 summarize.py ${REPORT}`,
    { timeoutMs: 910_000 },
  );
  if (run.exitCode !== 0) throw new Error(`acceptance suite did not produce a report: ${tail(run.stderr || run.stdout, 800)}`);
  const cases = JSON.parse(run.stdout) as CaseResult[];
  const passed = cases.filter((c) => c.outcome === "passed").length;
  const failed = cases.filter((c) => c.outcome === "failed").length;
  return { cases, passed, failed, ok: failed === 0 && passed > 0 };
}

function report(run: AcceptanceRun): string {
  const lines = run.cases.map((c) => `${c.outcome.toUpperCase()} ${c.test}${c.outcome === "failed" ? `: ${c.message.split("\n")[0]}` : ""}`);
  return `${run.passed} passed, ${run.failed} failed\n${lines.join("\n")}`;
}

async function emitAcceptance(run: AcceptanceRun): Promise<void> {
  console.log(`  acceptance: ${run.passed} passed, ${run.failed} failed`);
  for (const c of run.cases.filter((c) => c.outcome === "failed")) console.log(`    FAILED ${c.test}: ${c.message.split("\n")[0].slice(0, 200)}`);
  await emit({ type: "seller.test", passed: run.passed, failed: run.failed, output: `acceptance: ${tail(report(run), 4000)}` });
}

function failurePrompt(workspace: Workspace, facts: string, run: AcceptanceRun): string {
  const failures = run.cases
    .filter((c) => c.outcome === "failed")
    .map((c) => `- ${c.test}\n  message: ${tail(c.message, 1500)}${c.captured ? `\n  captured output: ${tail(c.captured, 1500)}` : ""}`)
    .join("\n");
  return `${HARDEN_BRIEF}

Environment:
${facts}

Current files in ${TOOL_DIR}:
${workspace.render()}

An independent acceptance suite, which you cannot see, checked the converter against the interface contract. ${run.passed} tests passed and these failed:
${failures}

Find the cause and fix the converter so it meets the contract. Add or adjust your own tests so they cover what failed. Return only the files you change, each with its full content and a path relative to ${TOOL_DIR}.`;
}

/** Runs the hidden suite; failures go back to the agent as names and messages only, then both suites run again. */
export async function acceptanceLoop(
  sandbox: Sandbox,
  workspace: Workspace,
  facts: string,
  suite: SealedSuite,
): Promise<{ check: CheckResult; record: AcceptanceRecord }> {
  await upload(sandbox, suite);
  await emit({
    type: "seller.step",
    step: "acceptance",
    detail: `uploaded the acceptance suite (${suite.files.length} files) to ${REMOTE_DIR}; it hashes to the sealed digest ${suite.digest.slice(0, 12)}…`,
  });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await emit({ type: "seller.step", step: "acceptance", detail: `round ${round}/${MAX_ROUNDS}: running the acceptance suite` });
    const run = await runAcceptance(sandbox);
    await emitAcceptance(run);
    if (run.ok) {
      return {
        check: { id: "acceptance", label: "independent acceptance suite", status: "pass", detail: `${run.passed} passed in round ${round}` },
        record: { suiteDigest: suite.digest, passed: run.passed, failed: run.failed, ranAt: new Date().toISOString() },
      };
    }
    if (round === MAX_ROUNDS) break;

    await emit({ type: "seller.step", step: "fix", detail: `${run.failed} acceptance failures, sending names and messages to the agent` });
    const fix = await askForFiles("fix", ENGINEER_SYSTEM, failurePrompt(workspace, facts, run));
    await emit({ type: "seller.step", step: "fix", detail: `agent (${fix.model}): ${fix.summary}` });
    await workspace.apply(fix.files, fix.model);

    const own = await testAndFix({ sandbox, workspace, facts, brief: HARDEN_BRIEF, phase: "acceptance", maxRuns: AGENT_RUNS_PER_ROUND });
    if (!own.run.ok) throw new Error(`agent's own tests failing after acceptance round ${round}; not publishing`);
  }
  throw new Error(`acceptance suite still failing after ${MAX_ROUNDS} rounds; not publishing`);
}
