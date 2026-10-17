import { randomBytes } from "node:crypto";
import { CreateosSandboxClient, CreateosSandboxNotFoundError, type Sandbox } from "@nodeops-createos/sandbox";
import { platformRequest } from "@polygraph/core";
import { config } from "./config.js";

const client = new CreateosSandboxClient({ apiKey: config.createos.apiKey, baseUrl: config.createos.baseUrl });

/** Mints a CreateOS access token that only works against this one sandbox. */
export async function mintAccessToken(sandboxId: string): Promise<string> {
  const r = await platformRequest<{ token?: string }>("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/access-token`, config.createos.apiKey, {});
  if (!r.data?.token) throw new Error(`access token for ${sandboxId} failed (${r.status}): ${r.error ?? "no token in response"}`);
  return r.data.token;
}

/** Forks a running worker from a paused parent. Forking needs the parent paused, so a running parent is refused. */
export async function forkWorker(parentSandboxId: string): Promise<{ worker: Sandbox; ms: number }> {
  const parent = await client.getSandbox(parentSandboxId);
  if (parent.status !== "paused") throw new Error(`parent sandbox ${parentSandboxId} is ${parent.status}, expected paused`);
  const started = performance.now();
  const worker = await parent.fork({});
  try {
    await worker.waitUntilRunning({ timeoutMs: 60_000 });
  } catch (err) {
    await destroyWorker(worker).catch(() => undefined);
    throw err;
  }
  return { worker, ms: Math.round(performance.now() - started) };
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

/** Destroys a worker; one that is already gone counts as destroyed. */
export async function destroyWorker(worker: Sandbox): Promise<void> {
  try {
    await worker.destroy();
  } catch (err) {
    if (!(err instanceof CreateosSandboxNotFoundError)) throw err;
  }
}
