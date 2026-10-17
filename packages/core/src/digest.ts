/** Where the seller packages the tool inside the parent sandbox, and so inside every worker forked from it. */
export const TOOL_DIR = "/opt/tool";

/**
 * Bash command that prints the artifact digest of the packaged tool: sha256 over a sorted
 * `sha256sum` listing of every file in TOOL_DIR, ignoring Python caches. The seller runs it before
 * publishing; the buyer runs it inside its worker and compares the result with `artifactDigest`.
 */
export const ARTIFACT_DIGEST_COMMAND =
  `cd ${TOOL_DIR} && find . -type f ! -path './.pytest_cache/*' ! -path '*/__pycache__/*' ! -name '*.pyc' -print0` +
  ` | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`;

/** Command line for the packaged converter. It prints the path of the PDF it wrote as its last stdout line. */
export function converterArgv(inputPath: string, outputDir: string): { cmd: string; args: string[] } {
  return { cmd: "python3", args: [`${TOOL_DIR}/convert.py`, inputPath, outputDir] };
}
