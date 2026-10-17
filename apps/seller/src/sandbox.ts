import { CreateosSandboxClient, CreateosSandboxNotFoundError, CreateosSandboxRateLimitError, sleep, type CreateSandboxRequest, type ForkSandboxRequest, type Sandbox } from "@nodeops-createos/sandbox";
import { PLATFORM_URL, emit } from "@polygraph/core";

export const SHAPE = "s-2vcpu-4gb";
export const ROOTFS = "devbox:1";
export const UPSTREAM_DIR = "/opt/upstream";

/**
 * A non-empty allowlist denies everything it does not name. Port 9 (discard) on loopback is
 * never served, so this list leaves the sandbox with no usable outbound network.
 */
export const LOCKED_EGRESS = ["127.0.0.1:9"];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
}

const QUOTA_RETRY_MS = 5_000;
const QUOTA_RETRIES = 48;

/** The account caps concurrent sandboxes (paused ones count), so a 429 means wait for a slot, not fail. */
async function withQuotaRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof CreateosSandboxRateLimitError) || tries >= QUOTA_RETRIES) throw err;
      const note = `${label}: sandbox quota full, retrying every ${QUOTA_RETRY_MS / 1000} s`;
      if (tries === 1) await emit({ type: "seller.step", step: "quota", detail: note });
      else console.log(`  ${note} (${tries}/${QUOTA_RETRIES})`);
      await sleep(QUOTA_RETRY_MS);
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; add it to .env`);
  return value;
}

export function createClient(): CreateosSandboxClient {
  return new CreateosSandboxClient({ apiKey: requireEnv("CREATEOS_SANDBOX_API_KEY"), baseUrl: PLATFORM_URL });
}

/**
 * Runs a bash script as a login shell (so PATH matches an interactive session).
 * The HTTP budget is padded past `timeoutMs` because scripts enforce their own limits with `timeout`.
 */
export async function sh(sandbox: Sandbox, script: string, options: { timeoutMs?: number; stdin?: string } = {}): Promise<ShellResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const response = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs: timeoutMs + 30_000, stdin: options.stdin, retry: false });
  return {
    stdout: response.result.stdout,
    stderr: response.result.stderr,
    exitCode: response.result.exit_code,
    ms: Date.now() - started,
  };
}

/** Like `sh`, but a non-zero exit is an error. */
export async function mustSh(sandbox: Sandbox, label: string, script: string, timeoutMs?: number): Promise<ShellResult> {
  const result = await sh(sandbox, script, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout, 1500)}`);
  }
  return result;
}

export function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Tracks every sandbox this run creates so a failure never leaves billable machines behind.
 * Sandboxes marked with `keep` (the published parent and the foils) survive a successful run.
 */
export class SandboxRegistry {
  private readonly owned = new Map<string, { sandbox: Sandbox; role: string; keep: boolean }>();

  constructor(readonly client: CreateosSandboxClient) {}

  async create(role: string, request: CreateSandboxRequest): Promise<Sandbox> {
    const sandbox = await withQuotaRetry(`create ${role}`, () => this.client.createSandbox(request));
    this.owned.set(sandbox.id, { sandbox, role, keep: false });
    await sandbox.waitUntilRunning({ timeoutMs: 120_000 });
    return sandbox;
  }

  /** Forks a paused source and waits for the copy to settle: paused with `start_paused`, otherwise running. */
  async fork(source: Sandbox, role: string, request: ForkSandboxRequest = {}): Promise<Sandbox> {
    const copy = await withQuotaRetry(`fork ${role}`, () => source.fork(request));
    this.owned.set(copy.id, { sandbox: copy, role, keep: false });
    if (request.start_paused) await copy.waitUntilPaused({ timeoutMs: 240_000 });
    else await copy.waitUntilRunning({ timeoutMs: 240_000 });
    return copy;
  }

  keep(sandbox: Sandbox): void {
    const entry = this.owned.get(sandbox.id);
    if (entry) entry.keep = true;
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    this.owned.delete(sandbox.id);
    try {
      await sandbox.destroy();
    } catch (err) {
      console.warn(`[sandbox] could not destroy ${sandbox.id}: ${(err as Error).message}`);
    }
  }

  /** Destroys what this run created. With `includeKept` the published sandboxes go too (used on failure). */
  async cleanup(includeKept: boolean): Promise<void> {
    const doomed = [...this.owned.values()].filter((entry) => includeKept || !entry.keep);
    await Promise.all(
      doomed.map(async ({ sandbox, role }) => {
        await this.destroy(sandbox);
        await emit({ type: "seller.step", step: "cleanup", detail: `destroyed ${role} ${sandbox.id}` });
      }),
    );
  }

  describe(): string[] {
    return [...this.owned.values()].map(({ sandbox, role, keep }) => `${role} ${sandbox.id}${keep ? " (kept)" : ""}`);
  }
}

/** Destroys a sandbox this run did not create (an earlier foil). A sandbox that is already gone is fine. */
export async function destroyById(client: CreateosSandboxClient, id: string): Promise<void> {
  try {
    await (await client.getSandbox(id)).destroy();
  } catch (err) {
    if (!(err instanceof CreateosSandboxNotFoundError)) throw err;
  }
}

/** Pauses a sandbox and waits until the platform reports it paused. */
export async function pauseAndWait(sandbox: Sandbox): Promise<void> {
  await sandbox.pause();
  await sandbox.waitUntilPaused({ timeoutMs: 180_000 });
}

/** Sets the allowlist and returns the list as the platform now reports it. */
export async function applyEgress(sandbox: Sandbox, rules: string[]): Promise<string[]> {
  await sandbox.setEgress(rules.length === 0 ? null : rules);
  return (await sandbox.getEgress()).egress ?? [];
}

/** Tries an HTTPS request from inside the sandbox. Returns whether it was blocked and what curl said. */
export async function probeEgress(sandbox: Sandbox, url = "https://example.com"): Promise<{ blocked: boolean; detail: string }> {
  const result = await sh(sandbox, `curl -sS -m 8 -o /dev/null -w '%{http_code}' ${shellQuote(url)}`, { timeoutMs: 20_000 });
  if (result.exitCode === 0) return { blocked: false, detail: `${url} answered HTTP ${result.stdout.trim()}` };
  return { blocked: true, detail: `${url} unreachable: ${result.stderr.trim() || `curl exit ${result.exitCode}`}` };
}
