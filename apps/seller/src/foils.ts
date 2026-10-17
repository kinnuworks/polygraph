import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, emit, type OfferManifest, type SignedManifest } from "@polygraph/core";
import { computeDigest, newOfferId, publishOffer, type FoilKind } from "./publish.js";
import { applyEgress, mustSh, pauseAndWait, type SandboxRegistry } from "./sandbox.js";

/*
 * Foils are negative test fixtures for the demo. Each one is a validly signed offer whose claims
 * disagree with the platform's records in exactly one way, so the buyer has to catch it from evidence:
 *   egress:   the worker parent has open egress while the manifest states the locked list.
 *   artifact: one byte of convert.py differs while the manifest states the original digest.
 */

export type Tampering = "egress" | "artifact";

export const FOIL_KIND: Record<Tampering, FoilKind> = { egress: "lying-egress", artifact: "tampered-artifact" };

/** Opens the fork's egress completely. The manifest will keep claiming the locked list. */
async function openEgress(fork: Sandbox, genuine: OfferManifest): Promise<string> {
  const egress = await applyEgress(fork, []);
  if (egress.length !== 0) throw new Error(`egress still restricted after opening: [${egress.join(", ")}]`);
  return `egress opened, manifest will state [${genuine.egress.join(", ")}]`;
}

/** Changes one byte of convert.py. The manifest will keep claiming the original digest. */
async function changeOneByte(fork: Sandbox, genuine: OfferManifest): Promise<string> {
  const egress = (await fork.getEgress()).egress ?? [];
  if (egress.join(",") !== genuine.egress.join(",")) {
    throw new Error(`fork egress [${egress.join(", ")}] differs from the parent's; only the digest should differ`);
  }
  // Flip the trailing byte between newline and space: Python still parses the file, but its hash changes.
  await mustSh(
    fork,
    "change one byte",
    `python3 -c 'import sys; p=sys.argv[1]; d=bytearray(open(p,"rb").read()); d[-1] = 0x20 if d[-1] == 0x0a else 0x0a; open(p,"wb").write(d)' ${TOOL_DIR}/convert.py`,
  );
  const { digest } = await computeDigest(fork);
  if (digest === genuine.artifactDigest) throw new Error("digest unchanged after editing convert.py");
  return `convert.py changed by one byte, digest now ${digest.slice(0, 12)}…, manifest will state ${genuine.artifactDigest.slice(0, 12)}…`;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Forks the paused genuine parent, applies one real tampering, leaves the fork paused and publishes a
 * validly signed manifest that still claims the genuine values.
 */
export async function publishTampered(
  registry: SandboxRegistry,
  parent: Sandbox,
  genuine: OfferManifest,
  tampering: Tampering,
  name: string,
): Promise<SignedManifest> {
  // Egress is a control-plane setting and can change while the fork stays paused; editing a file needs it running.
  const needsExec = tampering === "artifact";
  const t0 = Date.now();
  const fork = await registry.fork(parent, `${name} parent`, { start_paused: !needsExec });
  registry.keep(fork);
  const t1 = Date.now();
  const change = needsExec ? await changeOneByte(fork, genuine) : await openEgress(fork, genuine);
  const t2 = Date.now();
  if (needsExec) await pauseAndWait(fork);
  const timing = `fork ${secs(t1 - t0)}, tamper ${secs(t2 - t1)}${needsExec ? `, pause ${secs(Date.now() - t2)}` : ""}`;
  await emit({ type: "seller.step", step: "foil", detail: `${name} ${fork.id}: ${change} (${timing})` });
  const manifest: OfferManifest = { ...genuine, offerId: newOfferId(), name, parentSandboxId: fork.id, createdAt: new Date().toISOString() };
  return publishOffer(manifest, FOIL_KIND[tampering]);
}

/** Builds both standing foils from the paused parent. */
export async function createFoils(registry: SandboxRegistry, parent: Sandbox, genuine: OfferManifest): Promise<SignedManifest[]> {
  await emit({ type: "seller.step", step: "foil", detail: "forking the parent for two test foils" });
  const a = await publishTampered(registry, parent, genuine, "egress", "Document to PDF (test foil A)");
  const b = await publishTampered(registry, parent, genuine, "artifact", "Document to PDF (test foil B)");
  return [a, b];
}
