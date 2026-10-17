import { ARTIFACT_LIST_COMMAND, sha256, TOOL_DIR } from "@polygraph/core";
import type { RemoteSandbox } from "./worker.js";

/** The packaged tool as the buyer downloaded it: relative path ("./convert.py") to file bytes. */
export type Bundle = Map<string, Buffer>;

const DOWNLOAD_CONCURRENCY = 6;

/** Asks the worker which files the digest covers; the bytes themselves come through the files API. */
async function listBundle(worker: RemoteSandbox): Promise<string[]> {
  const run = await worker.sh(ARTIFACT_LIST_COMMAND);
  if (run.exitCode !== 0) throw new Error(`listing ${TOOL_DIR} exited ${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  const paths = run.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) throw new Error(`no files under ${TOOL_DIR}`);
  for (const path of paths) {
    if (!path.startsWith("./") || path.split("/").includes("..")) throw new Error(`unexpected path in listing: ${JSON.stringify(path)}`);
  }
  return paths;
}

/** Downloads every file of the packaged tool through the platform's files API. */
export async function downloadBundle(worker: RemoteSandbox): Promise<Bundle> {
  const paths = await listBundle(worker);
  const bundle: Bundle = new Map();
  for (let i = 0; i < paths.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = paths.slice(i, i + DOWNLOAD_CONCURRENCY);
    const files = await Promise.all(batch.map((path) => worker.download(`${TOOL_DIR}/${path.slice(2)}`)));
    batch.forEach((path, j) => bundle.set(path, files[j] as Buffer));
  }
  return bundle;
}

/** One line of `sha256sum` output, including its escaping of backslashes and line breaks in names. */
function sha256sumLine(path: string, bytes: Buffer): string {
  const escaped = /[\\\n\r]/.test(path);
  const name = escaped ? path.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r") : path;
  return `${escaped ? "\\" : ""}${sha256(bytes)}  ${name}\n`;
}

/**
 * Recomputes ARTIFACT_DIGEST_COMMAND in Node: files sorted by the bytes of their path (as
 * `LC_ALL=C sort -z` does), one `sha256sum` line each, then sha256 of the whole listing.
 */
export function bundleDigest(bundle: Bundle): string {
  const paths = [...bundle.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(paths.map((path) => sha256sumLine(path, bundle.get(path) as Buffer)).join(""));
}

export const bundleBytes = (bundle: Bundle) => [...bundle.values()].reduce((total, bytes) => total + bytes.length, 0);
