import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, emit, type CheckResult } from "@polygraph/core";
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

async function upload(sandbox: Sandbox): Promise<number> {
  const names = (await readdir(LOCAL_DIR)).filter((name) => name.endsWith(".py"));
  for (const name of names) await sandbox.files.upload(`${REMOTE_DIR}/${name}`, await readFile(join(LOCAL_DIR, name)));
  return names.length;
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
export async function acceptanceLoop(sandbox: Sandbox, workspace: Workspace, facts: string): Promise<CheckResult> {
  const files = await upload(sandbox);
  await emit({ type: "seller.step", step: "acceptance", detail: `uploaded the independent acceptance suite (${files} files) to ${REMOTE_DIR}` });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await emit({ type: "seller.step", step: "acceptance", detail: `round ${round}/${MAX_ROUNDS}: running the acceptance suite` });
    const run = await runAcceptance(sandbox);
    await emitAcceptance(run);
    if (run.ok) {
      return { id: "acceptance", label: "independent acceptance suite", status: "pass", detail: `${run.passed} passed in round ${round}` };
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
