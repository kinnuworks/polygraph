import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, emit, type CheckResult } from "@polygraph/core";
import { ENGINEER_SYSTEM, INTERFACE_CONTRACT, SPEC, testAndFix, type TestRun, type Workspace } from "./build.js";
import { askForFiles } from "./llm.js";
import { LOCKED_EGRESS, applyEgress, probeEgress } from "./sandbox.js";

const ROBUSTNESS_FILE = "tests/test_robustness.py";

/** Each robustness case is one named pytest test, so its result can be read straight from the run. */
const CASES = [
  {
    test: "test_oversized_input_rejected",
    label: "oversized input rejected",
    requirement:
      "convert.py enforces an input size cap. The test writes a 30 MB file of random bytes named big.docx into tmp_path and expects a non-zero exit with a clear one-line error on stderr and no traceback.",
  },
  {
    test: "test_corrupt_input_reports_error",
    label: "corrupt input reports a clear error",
    requirement:
      "A corrupt input (a few random bytes, or a truncated copy of a valid fixture, named .docx) makes convert.py exit non-zero with a clear message on stderr instead of a Python traceback.",
  },
  {
    test: "test_conversion_timeout_enforced",
    label: "conversion bounded by a timeout",
    requirement:
      "convert.py passes a timeout to the soffice subprocess and reports a clear error when it expires. The test shows a stalled conversion is stopped within the limit (for example with a configurable timeout and a stand-in soffice that only sleeps).",
  },
  {
    test: "test_output_stays_in_output_dir",
    label: "output stays inside the output directory",
    requirement:
      "The output directory argument is resolved to an absolute path and the PDF is written inside it; the printed path is inside that directory even when the argument is relative or contains '..'.",
  },
] as const;

const HARDEN_BRIEF = `Task: ${SPEC}

${INTERFACE_CONTRACT}

Robustness requirements, each covered by the named test in ${ROBUSTNESS_FILE}:
${CASES.map((c) => `- ${c.test}: ${c.requirement}`).join("\n")}`;

function robustnessPrompt(workspace: Workspace, facts: string): string {
  return `${HARDEN_BRIEF}

Environment:
${facts}

Current files in ${TOOL_DIR}:
${workspace.render()}

Add ${ROBUSTNESS_FILE} with exactly these test function names, and change convert.py (or other files) as needed so the converter meets the requirements. Tests must write only to tmp_path. Return only the files you add or change, each with its full content and a path relative to ${TOOL_DIR}.`;
}

/** Reads per-test outcomes from pytest's `-rA` short summary. */
function outcomes(output: string): Map<string, "PASSED" | "FAILED" | "ERROR"> {
  const result = new Map<string, "PASSED" | "FAILED" | "ERROR">();
  for (const match of output.matchAll(/^(PASSED|FAILED|ERROR) \S*::(\w+)/gm)) {
    result.set(match[2] as string, match[1] as "PASSED" | "FAILED" | "ERROR");
  }
  return result;
}

async function emitCases(run: TestRun): Promise<CheckResult[]> {
  const seen = outcomes(run.output);
  const checks: CheckResult[] = [];
  for (const c of CASES) {
    const outcome = seen.get(c.test);
    const ok = outcome === "PASSED";
    const detail = outcome ? `${c.test} ${outcome.toLowerCase()}` : `${c.test} did not run`;
    await emit({ type: "seller.attack", attack: c.label, status: ok ? "passed" : "crashed", detail });
    console.log(`  ${c.label}: ${ok ? "passed" : "crashed"} (${detail})`);
    checks.push({ id: c.test, label: c.label, status: ok ? "pass" : "fail", detail });
  }
  return checks;
}

/** Locks the network, proves it from inside, then has the agent add robustness tests and fixes what really fails. */
export async function harden(sandbox: Sandbox, workspace: Workspace, facts: string): Promise<{ egress: string[]; checks: CheckResult[] }> {
  const egress = await applyEgress(sandbox, LOCKED_EGRESS);
  await emit({ type: "seller.step", step: "harden", detail: `egress locked to [${egress.join(", ")}]` });
  const probe = await probeEgress(sandbox);
  await emit({ type: "seller.attack", attack: "network locked", status: probe.blocked ? "blocked" : "crashed", detail: probe.detail });
  if (!probe.blocked) throw new Error(`egress lock not effective: ${probe.detail}`);
  const networkCheck: CheckResult = { id: "egress-probe", label: "network locked", status: "pass", detail: probe.detail };

  await emit({ type: "seller.step", step: "harden", detail: `agent is adding robustness tests: ${CASES.map((c) => c.label).join("; ")}` });
  const reply = await askForFiles(ENGINEER_SYSTEM, robustnessPrompt(workspace, facts));
  await emit({ type: "seller.step", step: "harden", detail: `agent: ${reply.summary}` });
  await workspace.apply(reply.files);

  let caseChecks: CheckResult[] = [];
  const { run, attempts } = await testAndFix({
    sandbox,
    workspace,
    facts,
    brief: HARDEN_BRIEF,
    phase: "harden",
    onRun: async (r) => {
      caseChecks = await emitCases(r);
    },
  });
  if (!run.ok) throw new Error(`suite still failing after ${attempts} hardening runs; not publishing`);
  const suiteCheck: CheckResult = { id: "tests", label: "pytest suite", status: "pass", detail: `${run.passed} passed after hardening (run ${attempts})` };
  return { egress, checks: [suiteCheck, networkCheck, ...caseChecks] };
}
