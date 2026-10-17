import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, emit, type CheckResult } from "@polygraph/core";
import { askForFiles, type ToolFile } from "./llm.js";
import { UPSTREAM_DIR, mustSh, sh, shellQuote, tail } from "./sandbox.js";

export const SPEC =
  "Package this tool as a command-line converter: given an input office document path and an output directory, produce a PDF. Include pytest tests.";

const MAX_TEST_RUNS = 6;
const STAGING_DIR = "/tmp/staging";

export const ENGINEER_SYSTEM = [
  "You are the engineer inside a seller agent. You package open-source tools as small, dependable command-line programs that run inside a Linux sandbox.",
  "You return complete files. When something fails you read the real output, find the cause and fix it; you never hide a failure.",
].join(" ");

export const INTERFACE_CONTRACT = `Interface contract (other programs depend on it, and an independent acceptance suite you cannot see checks it):
- Command: \`python3 ${TOOL_DIR}/convert.py <input> <outdir>\`.
- Supported input extensions: .docx .odt .rtf .pptx .xlsx.
- Writes <outdir>/<input stem>.pdf and prints that absolute path as the last line of stdout.
- Exit codes: 0 on success; 2 for an unsupported extension or an unreadable or corrupt input; 3 for an input over 25 MB; 4 on timeout (60 s).
- Must work when two conversions run at the same time.
- File names may contain spaces and non-ASCII characters.
- The PDF must contain the input's text.
- Python standard library only; nothing may be installed with pip.
- At run time the program has no outbound network access.`;

/** Mirror of the files the agent has written into TOOL_DIR, kept in step with the sandbox. */
export class Workspace {
  private readonly files = new Map<string, string>();

  constructor(private readonly sandbox: Sandbox) {}

  /**
   * Writes changed files into TOOL_DIR and reports a unified diff for each one.
   * The diff is computed inside the sandbox against what is really on disk.
   */
  async apply(changes: ToolFile[]): Promise<{ file: string; diff: string }[]> {
    const patches: { file: string; diff: string }[] = [];
    for (const change of changes) {
      if (this.files.get(change.path) === change.content) continue;
      const staged = `${STAGING_DIR}/${change.path}`;
      const target = `${TOOL_DIR}/${change.path}`;
      await this.sandbox.files.upload(staged, change.content);
      const result = await sh(
        this.sandbox,
        [
          `old=${shellQuote(target)}; [ -f "$old" ] || old=/dev/null`,
          `diff -u --label a/${shellQuote(change.path)} --label b/${shellQuote(change.path)} "$old" ${shellQuote(staged)}`,
          `status=$?`,
          `mkdir -p "$(dirname ${shellQuote(target)})" && cp ${shellQuote(staged)} ${shellQuote(target)} || exit 3`,
          `[ $status -le 1 ] || exit 2`,
        ].join("\n"),
      );
      if (result.exitCode !== 0) throw new Error(`could not write ${change.path}: ${result.stderr}`);
      this.files.set(change.path, change.content);
      patches.push({ file: change.path, diff: result.stdout });
      console.log(`  ${change.path}: ${diffStat(result.stdout)}`);
      await emit({ type: "seller.patch", file: change.path, diff: result.stdout });
    }
    return patches;
  }

  render(): string {
    return [...this.files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, content]) => `=== ${path} ===\n${content}`)
      .join("\n\n");
  }
}

function diffStat(diff: string): string {
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return `+${added} -${removed}`;
}

export interface TestRun {
  passed: number;
  failed: number;
  exitCode: number;
  output: string;
  ok: boolean;
}

export async function runTests(sandbox: Sandbox): Promise<TestRun> {
  // Bytecode and pytest caches are kept out of the tool directory so the packaged files stay exactly what the agent wrote.
  const result = await sh(sandbox, `cd ${TOOL_DIR} && PYTHONDONTWRITEBYTECODE=1 timeout 600 python3 -m pytest -q -rA -p no:cacheprovider 2>&1`, {
    timeoutMs: 610_000,
  });
  const output = result.stdout + result.stderr;
  const summary = output.split("\n").reverse().find((line) => /\d+ (passed|failed|errors?)\b/.test(line)) ?? "";
  const count = (word: string) => Number(summary.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  const passed = count("passed");
  const failed = count("failed") + count("errors?");
  return { passed, failed, exitCode: result.exitCode, output, ok: result.exitCode === 0 && failed === 0 && passed > 0 };
}

export async function emitTestRun(suite: string, run: TestRun): Promise<void> {
  console.log(`  ${suite}: ${run.passed} passed, ${run.failed} failed (exit ${run.exitCode})`);
  await emit({ type: "seller.test", passed: run.passed, failed: run.failed, output: `${suite}: ${tail(run.output, 4000)}` });
}

// Writer, Calc and Impress cover every supported input format; poppler-utils gives pdftotext for checking output.
const PACKAGES = ["libreoffice-writer-nogui", "libreoffice-calc-nogui", "libreoffice-impress-nogui", "python3-uno", "poppler-utils"];

/** Installs LibreOffice and clones the upstream project for reference and its licence. */
export async function provision(sandbox: Sandbox, repo: string): Promise<void> {
  await emit({ type: "seller.step", step: "provision", detail: `installing ${PACKAGES.join(" ")}` });
  const apt = await mustSh(
    sandbox,
    "apt-get install",
    `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq --no-install-recommends ${PACKAGES.join(" ")} >/dev/null`,
    600_000,
  );
  await emit({ type: "seller.step", step: "provision", detail: `LibreOffice installed in ${(apt.ms / 1000).toFixed(0)} s` });
  await mustSh(sandbox, "git clone", `rm -rf ${UPSTREAM_DIR} && git clone -q --depth 1 ${shellQuote(repo)} ${UPSTREAM_DIR}`, 180_000);
  const head = await mustSh(sandbox, "git log", `git -C ${UPSTREAM_DIR} log -1 --format='%h %s'`);
  await emit({ type: "seller.step", step: "provision", detail: `cloned ${repo} at ${head.stdout.trim()}` });
  await mustSh(sandbox, "pytest", "python3 -m pytest --version >/dev/null 2>&1 || python3 -m pip install -q pytest", 180_000);
}

/** Facts the agent gets about its machine, measured rather than assumed. */
async function environmentFacts(sandbox: Sandbox): Promise<string> {
  const login = await sh(
    sandbox,
    [
      `echo "os: $(. /etc/os-release && echo "$PRETTY_NAME")"`,
      `echo "python3 (login shell): $(command -v python3) $(python3 --version 2>&1)"`,
      `echo "pytest: $(python3 -m pytest --version 2>&1 | head -1)"`,
      `echo "soffice: $(command -v soffice) -> $(readlink -f "$(command -v soffice)")"`,
      `echo "libreoffice-writer-nogui: $(dpkg-query -W -f='\${Version}' libreoffice-writer-nogui)"`,
      `echo "pdftotext: $(command -v pdftotext)"`,
      `echo "user: $(id -un), cpus: $(nproc), memory: $(free -m | awk '/Mem:/ {print $2}') MiB"`,
    ].join("\n"),
  );
  const direct = await sandbox.runCommand("sh", ["-c", `echo "python3 (non-login exec): $(command -v python3) $(python3 --version 2>&1)"`]);
  return `${login.stdout.trim()}\n${direct.result.stdout.trim()}`;
}

async function readmeExcerpt(sandbox: Sandbox): Promise<string> {
  const result = await sh(sandbox, `f=$(ls ${UPSTREAM_DIR} | grep -i -m1 '^readme'); head -c 6000 "${UPSTREAM_DIR}/$f"`);
  return result.stdout;
}

function initialPrompt(repo: string, readme: string, facts: string): string {
  return `Task: ${SPEC}

${INTERFACE_CONTRACT}

Return these files, with paths relative to ${TOOL_DIR}:
- convert.py
- tests/test_convert.py (pytest)
- a small fixture generator (for example tests/make_fixtures.py) that builds sample input documents at test time

Tests run with \`cd ${TOOL_DIR} && python3 -m pytest -q\`. Tests must write only to temporary directories (pytest's tmp_path), never into ${TOOL_DIR}.

Upstream project: ${repo} (cloned at ${UPSTREAM_DIR} for reference and licence).
README excerpt:
${readme}

Environment, measured in the sandbox just now:
${facts}`;
}

function fixPrompt(brief: string, workspace: Workspace, run: TestRun, facts: string): string {
  return `${brief}

Environment:
${facts}

Current files in ${TOOL_DIR}:
${workspace.render()}

I ran \`cd ${TOOL_DIR} && python3 -m pytest -q\`. Exit code ${run.exitCode}. Output:
${tail(run.output, 12_000)}

Find the root cause in this output and fix it. Return only the files you change, each with its full new content. Change a test only if the test itself is wrong, and say so in the summary.`;
}

const BUILD_BRIEF = `Task: ${SPEC}\n\n${INTERFACE_CONTRACT}`;

/**
 * Runs the suite for real and hands every failure, with its actual output, back to the agent for a patch.
 * Returns the last run; `ok` is false only if the run budget was exhausted.
 */
export async function testAndFix(options: {
  sandbox: Sandbox;
  workspace: Workspace;
  facts: string;
  brief: string;
  phase: string;
  maxRuns?: number;
  onRun?: (run: TestRun) => Promise<void>;
}): Promise<{ run: TestRun; attempts: number }> {
  const { sandbox, workspace, facts, brief, phase } = options;
  const maxRuns = options.maxRuns ?? MAX_TEST_RUNS;
  for (let attempt = 1; ; attempt++) {
    await emit({ type: "seller.step", step: phase, detail: `run ${attempt}/${maxRuns}: python3 -m pytest -q` });
    const run = await runTests(sandbox);
    await emitTestRun("agent tests", run);
    await options.onRun?.(run);
    if (run.ok || attempt === maxRuns) return { run, attempts: attempt };
    await emit({ type: "seller.step", step: "fix", detail: `${run.failed} failing, sending the real output back to the agent` });
    const fix = await askForFiles(ENGINEER_SYSTEM, fixPrompt(brief, workspace, run, facts));
    await emit({ type: "seller.step", step: "fix", detail: `agent: ${fix.summary}` });
    const patches = await workspace.apply(fix.files);
    if (patches.length === 0) await emit({ type: "seller.step", step: "fix", detail: "agent proposed no file changes" });
  }
}

export interface BuildResult {
  workspace: Workspace;
  facts: string;
  testCheck: CheckResult;
  testRuns: number;
}

/** The write, run and fix loop: the agent writes the tool, we run its tests for real, failures go back to it. */
export async function buildTool(sandbox: Sandbox, repo: string): Promise<BuildResult> {
  const facts = await environmentFacts(sandbox);
  const readme = await readmeExcerpt(sandbox);
  const workspace = new Workspace(sandbox);

  await emit({ type: "seller.step", step: "write", detail: "agent is writing convert.py, tests and fixtures from a one-line spec" });
  const first = await askForFiles(ENGINEER_SYSTEM, initialPrompt(repo, readme, facts));
  await emit({ type: "seller.step", step: "write", detail: `agent: ${first.summary}` });
  await workspace.apply(first.files);

  const { run, attempts } = await testAndFix({ sandbox, workspace, facts, brief: BUILD_BRIEF, phase: "test" });
  if (!run.ok) throw new Error(`tests still failing after ${attempts} runs; not publishing`);
  return {
    workspace,
    facts,
    testRuns: attempts,
    testCheck: { id: "tests", label: "pytest suite", status: "pass", detail: `${run.passed} passed on run ${attempts}` },
  };
}
