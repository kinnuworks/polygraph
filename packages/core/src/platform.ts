import type { PlatformView } from "./types.js";

export const PLATFORM_URL = process.env.CREATEOS_SANDBOX_BASE_URL ?? "https://api-eu.sb.createos.sh";

type Envelope<T> = { status: string; data: T };

/**
 * Minimal CreateOS REST client used by both sides.
 * The seller calls it with its account key; the buyer calls it with a token scoped to one worker,
 * so the buyer's view of the worker comes from the platform, never from the seller.
 */
export async function platformRequest<T>(method: string, path: string, key: string, body?: unknown): Promise<{ status: number; data?: T; error?: string }> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method,
    headers: { "X-Api-Key": key, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Envelope<T> | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) return { status: res.status, error: typeof parsed?.data === "string" ? parsed.data : text.slice(0, 300) };
  return { status: res.status, data: parsed?.data };
}

/** Reads a sandbox the way a buyer sees it: lineage, egress, image, status. */
export async function readPlatformView(sandboxId: string, token: string): Promise<{ status: number; view?: PlatformView; error?: string }> {
  const r = await platformRequest<any>("GET", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`, token);
  if (!r.data) return { status: r.status, error: r.error };
  return {
    status: r.status,
    view: {
      sandboxId: r.data.id,
      forkedFrom: r.data.forked_from || null,
      egress: r.data.egress ?? [],
      rootfs: r.data.rootfs,
      status: r.data.status,
    },
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
}

export async function execIn(sandboxId: string, key: string, cmd: string, args: string[] = [], timeoutMs = 120_000): Promise<{ status: number; result?: ExecResult; error?: string }> {
  const r = await platformRequest<any>("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, key, { cmd, args, timeout_ms: timeoutMs });
  if (!r.data) return { status: r.status, error: r.error };
  return {
    status: r.status,
    result: { stdout: r.data.result?.stdout ?? "", stderr: r.data.result?.stderr ?? "", exitCode: r.data.result?.exit_code ?? -1, ms: r.data.exec_ms ?? 0 },
  };
}
