import { randomBytes } from "node:crypto";
import {
  CreateosSandboxClient,
  CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError,
  CreateosSandboxRateLimitError,
  type Sandbox,
} from "@nodeops-createos/sandbox";
import { platformRequest } from "@polygraph/core";
import { config } from "./config.js";
import { forgetWorker, trackWorker } from "./workers.js";

const client = new CreateosSandboxClient({ apiKey: config.createos.apiKey, baseUrl: config.createos.baseUrl });

const tokenPath = (sandboxId: string) => `/v1/sandboxes/${encodeURIComponent(sandboxId)}/access-token`;

/**
 * Issues a CreateOS access token that only works against this one sandbox. CreateOS keeps one token per
 * sandbox and answers 409 while one exists; rotating then replaces it, and the previous token stops working.
 */
export async function issueAccessToken(sandboxId: string): Promise<string> {
  let r = await platformRequest<{ token?: string }>("POST", tokenPath(sandboxId), config.createos.apiKey, {});
  if (r.status === 409) r = await platformRequest<{ token?: string }>("POST", `${tokenPath(sandboxId)}/rotate`, config.createos.apiKey, {});
  if (!r.data?.token) throw new Error(`access token for ${sandboxId} failed (${r.status}): ${r.error ?? "no token in response"}`);
  return r.data.token;
}

/** Disables the sandbox's access token. A sandbox that no longer exists has nothing to revoke. */
export async function revokeAccessToken(sandboxId: string): Promise<void> {
  const r = await platformRequest("DELETE", tokenPath(sandboxId), config.createos.apiKey);
  if (r.status >= 400 && r.status !== 404) throw new Error(`revoking the token for ${sandboxId} failed (${r.status}): ${r.error ?? ""}`);
}

/** True when CreateOS refused to create a sandbox because of the account's concurrency quota or credit. */
export const isCapacityError = (err: unknown) => err instanceof CreateosSandboxRateLimitError || err instanceof CreateosSandboxPaymentRequiredError;

/** Forks a running worker from a paused parent. Forking needs the parent paused, so a running parent is refused. */
export async function forkWorker(parentSandboxId: string): Promise<Sandbox> {
  const parent = await client.getSandbox(parentSandboxId);
  if (parent.status !== "paused") throw new Error(`parent sandbox ${parentSandboxId} is ${parent.status}, expected paused`);
  const worker = await parent.fork({});
  trackWorker(worker.id);
  try {
    await worker.waitUntilRunning({ timeoutMs: config.forkReadyTimeoutMs });
    // A parent with idle auto-pause would pass it on; a worker must stay running until it is used.
    if (worker.data.auto_pause_after_seconds) await worker.setAutoPause(null);
  } catch (err) {
    await destroyWorker(worker).catch(() => undefined);
    throw err;
  }
  return worker;
}

/** Re-reads the worker and reports whether it can take a job right now. */
export async function isRunning(worker: Sandbox): Promise<boolean> {
  try {
    await worker.refresh();
    return worker.status === "running";
  } catch (err) {
    if (err instanceof CreateosSandboxNotFoundError) return false;
    throw err;
  }
}

/**
 * A fork starts with its parent's RNG state and boot id. Mixing fresh bytes from the gateway into
 * /dev/urandom keeps two workers from the same parent from producing the same random values.
 */
export async function reseedWorker(worker: Sandbox): Promise<{ bootId: string }> {
  const seed = randomBytes(64).toString("hex");
  const script = [
    "set -e",
    "head -c 512 /dev/urandom > /dev/urandom",
    `printf '%s' '${seed}' > /dev/urandom`,
    "umask 077",
    `printf '%s' '${seed}' > /tmp/polygraph-seed`,
    "cat /proc/sys/kernel/random/boot_id",
  ].join("\n");
  const { result } = await worker.runCommand("sh", ["-c", script], { timeoutMs: 30_000 });
  if (result.exit_code !== 0) throw new Error(`reseed failed with exit code ${result.exit_code}: ${result.stderr.trim()}`);
  return { bootId: result.stdout.trim() };
}

/**
 * Destroys a worker, given its handle or id; one that is already gone counts as destroyed.
 * With `untilGone`, waits for CreateOS to finish, which is when its slot in the account quota frees up.
 */
export async function destroyWorker(worker: Sandbox | string, { untilGone = false } = {}): Promise<void> {
  const id = typeof worker === "string" ? worker : worker.id;
  try {
    const handle = typeof worker === "string" ? await client.getSandbox(worker) : worker;
    if (handle.status !== "destroying" && handle.status !== "destroyed") await handle.destroy();
    if (untilGone) await handle.waitUntilDestroyed({ timeoutMs: 30_000 });
  } catch (err) {
    if (!(err instanceof CreateosSandboxNotFoundError)) throw err;
  }
  forgetWorker(id);
}
