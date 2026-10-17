import { createHash } from "node:crypto";

/** Where the seller packages the tool inside the parent sandbox, and so inside every worker forked from it. */
export const TOOL_DIR = "/opt/tool";

/** NUL-separated list of the files the digest covers, as "./relative/path". */
export const ARTIFACT_LIST_COMMAND =
  `cd ${TOOL_DIR} && find . -type f ! -path './.pytest_cache/*' ! -path '*/__pycache__/*' ! -name '*.pyc' -print0`;

/**
 * Bash command that prints the artifact digest of the packaged tool: sha256 over a sorted
 * `sha256sum` listing of every file in TOOL_DIR, ignoring Python caches. The seller runs it before
 * publishing; the buyer runs it inside its worker and compares the result with `artifactDigest`.
 */
export const ARTIFACT_DIGEST_COMMAND = `${ARTIFACT_LIST_COMMAND} | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`;

/** Command line for the packaged converter. It prints the path of the PDF it wrote as its last stdout line. */
export function converterArgv(inputPath: string, outputDir: string): { cmd: string; args: string[] } {
  return { cmd: "python3", args: [`${TOOL_DIR}/convert.py`, inputPath, outputDir] };
}

/** Bash command that prints the acceptance suite digest of the .py files in `dir`, as `acceptanceSuiteDigest` computes it. */
export function acceptanceSuiteDigestCommand(dir: string): string {
  return `cd '${dir}' && find . -type f -name '*.py' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`;
}

/**
 * Digest of the acceptance suite, with the same scheme as the artifact digest: a `sha256sum` line per
 * file ("<hex>  ./<path>"), sorted by path bytes, then sha256 over that listing. Paths are relative to
 * the suite directory (apps/seller/acceptance in the repo, /opt/acceptance in the sandbox).
 */
export function acceptanceSuiteDigest(files: { path: string; content: Uint8Array }[]): string {
  const hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
  const listing = files
    .map((file) => ({ name: `./${file.path.replace(/^\.\//, "")}`, sum: hex(file.content) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .map((entry) => `${entry.sum}  ${entry.name}\n`)
    .join("");
  return hex(listing);
}
