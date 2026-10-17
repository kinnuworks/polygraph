import { execIn, PLATFORM_URL, type ExecResult } from "@polygraph/core";

/** Quotes one argument for `sh -c`. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A CreateOS sandbox the buyer reaches with a token scoped to that sandbox only.
 * Every call goes to the platform API directly, never through the seller's gateway.
 */
export class ScopedSandbox {
  constructor(
    readonly sandboxId: string,
    private readonly token: string,
  ) {}

  /** Runs a shell script inside the sandbox. Throws when the platform rejects the call. */
  async sh(script: string, timeoutMs = 120_000): Promise<ExecResult> {
    const r = await execIn(this.sandboxId, this.token, "sh", ["-c", script], timeoutMs);
    if (!r.result) throw new Error(`exec in ${this.sandboxId} failed (HTTP ${r.status}): ${r.error ?? "no result"}`);
    return r.result;
  }

  async upload(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const res = await fetch(this.filesUrl(path), {
      method: "PUT",
      headers: { "X-Api-Key": this.token, "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) throw new Error(`upload to ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  async download(path: string): Promise<Buffer> {
    const res = await fetch(this.filesUrl(path), { headers: { "X-Api-Key": this.token } });
    if (!res.ok) throw new Error(`download of ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private filesUrl(path: string): string {
    return `${PLATFORM_URL}/v1/sandboxes/${encodeURIComponent(this.sandboxId)}/files?path=${encodeURIComponent(path)}`;
  }
}
