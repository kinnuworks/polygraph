import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { converterArgv, emit, sha256, TOOL_DIR, type CheckResult } from "@polygraph/core";
import { shellQuote, type RemoteSandbox } from "./worker.js";

export interface JobResult {
  outputPath: string;
  inputSha256: string;
  outputSha256: string;
  pages: number;
  outputBytes: number;
  convertMs: number;
  checks: CheckResult[];
}

const JOB_DIR = "/tmp/polygraph-job";

/** Keeps the remote file name predictable and shell-safe. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_") || "input.docx";

/** Counts page objects; LibreOffice writes one `/Type /Page` dictionary per page. */
const countPages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

async function remoteSha256(worker: RemoteSandbox, path: string): Promise<string> {
  const run = await worker.sh(`sha256sum ${shellQuote(path)}`);
  return run.stdout.trim().split(/\s+/)[0] ?? "";
}

/** Uses pdfinfo inside the worker when the image has it, else counts page objects locally. */
async function pageCount(worker: RemoteSandbox, remotePdf: string, pdf: Buffer): Promise<{ pages: number; source: string }> {
  const run = await worker.sh(`command -v pdfinfo >/dev/null && pdfinfo ${shellQuote(remotePdf)} | awk '/^Pages:/ {print $2}'`);
  const pages = Number.parseInt(run.stdout.trim(), 10);
  return Number.isFinite(pages) && pages > 0 ? { pages, source: "pdfinfo" } : { pages: countPages(pdf), source: "page objects" };
}

/** Returns the remote PDF path, or "" when the tool left none. */
async function findPdf(worker: RemoteSandbox, stdout: string, searchDirs: string[]): Promise<string> {
  // The converter prints the PDF path as its last line; fall back to searching in case it does not.
  const printed = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") && l.endsWith(".pdf"));
  const fromStdout = printed.map((path) => `[ -f ${shellQuote(path)} ] && echo ${shellQuote(path)} && exit 0;`).join(" ");
  const run = await worker.sh(`${fromStdout} find ${searchDirs.map(shellQuote).join(" ")} -type f -name '*.pdf' 2>/dev/null | head -n 1`);
  return run.stdout.trim().split("\n")[0] ?? "";
}

/**
 * Runs the buyer's document through the tool in a verified sandbox (the seller's worker or the
 * buyer's own): upload, convert, download, then check the PDF on the buyer's side.
 */
export async function runJob(worker: RemoteSandbox, offerId: string, inputPath: string, outDir: string): Promise<JobResult> {
  const checks: CheckResult[] = [];
  const check = async (id: string, label: string, passed: boolean, detail: string) => {
    const result: CheckResult = { id, label, status: passed ? "pass" : "fail", detail };
    checks.push(result);
    await emit({ type: "buyer.check", offerId, check: result });
    if (!passed) throw new Error(`${label}: ${detail}`);
  };

  const input = await readFile(inputPath);
  const inputSha256 = sha256(input);
  const name = safeName(basename(inputPath));
  const stem = basename(name, extname(name));
  const remoteIn = `${JOB_DIR}/in/${name}`;
  const remoteOutDir = `${JOB_DIR}/out`;

  await emit({ type: "buyer.step", step: "upload", detail: `${name} (${input.length} bytes) to ${worker.sandboxId}` });
  await worker.sh(`rm -rf ${JOB_DIR} && mkdir -p ${JOB_DIR}/in ${remoteOutDir}`);
  await worker.upload(remoteIn, input);
  const uploaded = await remoteSha256(worker, remoteIn);
  await check("upload-intact", "Uploaded document is intact", uploaded === inputSha256, `sha256 ${inputSha256.slice(0, 16)}… local · ${uploaded.slice(0, 16) || "(none)"}… worker`);

  // LibreOffice fails silently without a writable HOME.
  const { cmd, args } = converterArgv(remoteIn, remoteOutDir);
  const command = `cd ${TOOL_DIR} && HOME=/tmp ${[cmd, ...args].map(shellQuote).join(" ")}`;
  await emit({ type: "buyer.step", step: "convert", detail: [cmd, ...args].join(" ") });

  const started = Date.now();
  const run = await worker.sh(command, 180_000);
  const convertMs = Date.now() - started;
  const tail = (run.stderr || run.stdout).trim().split("\n").slice(-3).join(" | ");
  await check("convert-exit", "Converter finished cleanly", run.exitCode === 0, `exit ${run.exitCode} in ${convertMs} ms${run.exitCode === 0 ? "" : `: ${tail}`}`);

  const remotePdf = await findPdf(worker, run.stdout, [remoteOutDir, `${JOB_DIR}/in`]);
  await check("output-found", "Converter produced a PDF", remotePdf !== "", remotePdf || `no .pdf under ${remoteOutDir}`);

  const pdf = await worker.download(remotePdf);
  const magic = pdf.subarray(0, 5).toString("latin1");
  await check("pdf-header", "Output is a PDF", magic === "%PDF-", `starts with ${JSON.stringify(magic)}, ${pdf.length} bytes`);

  const { pages, source } = await pageCount(worker, remotePdf, pdf);
  await check("pdf-pages", "PDF has pages", pages > 0, `${pages} pages (${source})`);
  const hasText = /\/Font\b/.test(pdf.toString("latin1"));
  await check("pdf-text", "PDF carries a text layer", hasText, hasText ? "font resources present" : "no font resources, likely blank or image-only");

  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${stem}.pdf`);
  await writeFile(outputPath, pdf);
  await emit({ type: "buyer.step", step: "downloaded", detail: `${outputPath} · ${pages} pages · ${pdf.length} bytes` });

  return { outputPath, inputSha256, outputSha256: sha256(pdf), pages, outputBytes: pdf.length, convertMs, checks };
}
