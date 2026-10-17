import { ARTIFACT_DIGEST_COMMAND, type CheckResult } from "@polygraph/core";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { getSandbox } from "./sandbox.js";

/** What the seller signed about every worker, kept with the purchase so a later republish cannot change it. */
export interface WorkerClaims {
  parentSandboxId: string;
  egress: string[];
  artifactDigest: string;
}

export interface WorkerAudit {
  /** True when any claim about the worker turned out false. */
  claimFailed: boolean;
  /** True when the buyer has already uploaded input, so the job ran or was under way. */
  jobStarted: boolean;
  checks: CheckResult[];
}

/** The buyer's job uploads its input here; anything in it means the worker was put to use. */
export const JOB_INPUT_DIR = "/tmp/polygraph-job/in";

const JOB_INPUT_PROBE = `test -d ${JOB_INPUT_DIR} && ls -A ${JOB_INPUT_DIR} | head -1`;

/** The first file in the job input directory, or "" when none: anything there means the worker was put to use. */
async function firstJobInput(worker: Sandbox): Promise<string> {
  return (await worker.runCommand("sh", ["-c", JOB_INPUT_PROBE], { timeoutMs: 30_000 })).result.stdout.trim();
}

/** Whether the buyer has uploaded job input to this worker. Throws when CreateOS cannot be asked. */
export async function jobInputPresent(workerSandboxId: string): Promise<boolean> {
  return (await firstJobInput(await getSandbox(workerSandboxId))) !== "";
}

const sameRules = (a: string[], b: string[]) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const formatRules = (rules: string[]) => (rules.length ? `[${[...rules].sort().join(", ")}]` : "[] (open internet)");

const check = (id: string, label: string, passed: boolean, detail: string): CheckResult => ({ id, label, status: passed ? "pass" : "fail", detail });

/**
 * Re-checks a sold worker with the owner key, independently of what the buyer reports: lineage and
 * egress as CreateOS records them, the tool digest computed inside the worker, and whether a job started.
 * Throws when CreateOS cannot be asked; a check that runs and disagrees is a failed check, not an error.
 */
export async function auditWorker(workerSandboxId: string, claims: WorkerClaims): Promise<WorkerAudit> {
  const worker = await getSandbox(workerSandboxId);
  const forkedFrom = worker.data.forked_from || "(none)";
  const egress = worker.data.egress ?? [];

  const [digestRun, firstInput] = await Promise.all([worker.runCommand("bash", ["-c", ARTIFACT_DIGEST_COMMAND], { timeoutMs: 60_000 }), firstJobInput(worker)]);
  const digest = /^([0-9a-f]{64})\b/.exec(digestRun.result.stdout.trim())?.[1];
  const digestDetail = digest
    ? `worker ${digest}, signed ${claims.artifactDigest}`
    : `digest command exited ${digestRun.result.exit_code}: ${(digestRun.result.stderr || digestRun.result.stdout).trim().slice(0, 200) || "no output"}`;

  const claimChecks = [
    check("lineage", "Worker forked from the signed parent", forkedFrom === claims.parentSandboxId, `CreateOS forked_from ${forkedFrom}, signed ${claims.parentSandboxId}`),
    check("egress", "Worker egress matches the signed allowlist", sameRules(egress, claims.egress), `CreateOS ${formatRules(egress)}, signed ${formatRules(claims.egress)}`),
    check("digest", "Tool digest inside the worker matches the signed digest", digest === claims.artifactDigest, digestDetail),
  ];
  const jobCheck = check("unused", "No job input uploaded yet", firstInput === "", firstInput ? `found ${JOB_INPUT_DIR}/${firstInput}` : `${JOB_INPUT_DIR} is empty or absent`);

  return {
    claimFailed: claimChecks.some((c) => c.status === "fail"),
    jobStarted: firstInput !== "",
    checks: [...claimChecks, jobCheck],
  };
}
