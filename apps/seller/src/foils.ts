import type { Sandbox } from "@nodeops-createos/sandbox";
import { TOOL_DIR, emit, type OfferManifest, type SignedManifest } from "@polygraph/core";
import { computeDigest, newOfferId, publishOffer } from "./publish.js";
import { applyEgress, mustSh, pauseAndWait, type SandboxRegistry } from "./sandbox.js";

/*
 * Foils are negative test fixtures for the demo. Each one is a validly signed offer whose claims
 * disagree with the platform's records in exactly one way, so the buyer has to catch it from evidence:
 *   A: the worker parent has open egress while the manifest states the locked list.
 *   B: one byte of convert.py differs while the manifest states the original digest.
 */

function foilManifest(genuine: OfferManifest, name: string, parentSandboxId: string): OfferManifest {
  return { ...genuine, offerId: newOfferId(), name, parentSandboxId, createdAt: new Date().toISOString() };
}

async function openEgressFoil(registry: SandboxRegistry, parent: Sandbox, genuine: OfferManifest): Promise<SignedManifest> {
  const fork = await registry.fork(parent, "foil A parent");
  registry.keep(fork);
  const egress = await applyEgress(fork, []);
  if (egress.length !== 0) throw new Error(`foil A: egress still restricted after opening: [${egress.join(", ")}]`);
  await emit({ type: "seller.step", step: "foil", detail: `foil A ${fork.id}: egress opened, manifest will state [${genuine.egress.join(", ")}]` });
  await pauseAndWait(fork);
  return publishOffer(foilManifest(genuine, "Document to PDF (test foil A)", fork.id), "lying-egress");
}

async function changedByteFoil(registry: SandboxRegistry, parent: Sandbox, genuine: OfferManifest): Promise<SignedManifest> {
  const fork = await registry.fork(parent, "foil B parent");
  registry.keep(fork);
  const egress = (await fork.getEgress()).egress ?? [];
  if (egress.join(",") !== genuine.egress.join(",")) {
    throw new Error(`foil B: fork egress [${egress.join(", ")}] differs from the parent's; only the digest should differ`);
  }
  // Flip the trailing byte between newline and space: Python still parses the file, but its hash changes.
  await mustSh(
    fork,
    "change one byte",
    `python3 -c 'import sys; p=sys.argv[1]; d=bytearray(open(p,"rb").read()); d[-1] = 0x20 if d[-1] == 0x0a else 0x0a; open(p,"wb").write(d)' ${TOOL_DIR}/convert.py`,
  );
  const { digest } = await computeDigest(fork);
  if (digest === genuine.artifactDigest) throw new Error("foil B: digest unchanged after editing convert.py");
  await emit({
    type: "seller.step",
    step: "foil",
    detail: `foil B ${fork.id}: convert.py changed by one byte, digest now ${digest.slice(0, 12)}…, manifest will state ${genuine.artifactDigest.slice(0, 12)}…`,
  });
  await pauseAndWait(fork);
  return publishOffer(foilManifest(genuine, "Document to PDF (test foil B)", fork.id), "tampered-artifact");
}

/** Builds both foils from the paused parent. The parent must already be paused. */
export async function createFoils(registry: SandboxRegistry, parent: Sandbox, genuine: OfferManifest): Promise<SignedManifest[]> {
  await emit({ type: "seller.step", step: "foil", detail: "forking the parent for two test foils" });
  const a = await openEgressFoil(registry, parent, genuine);
  const b = await changedByteFoil(registry, parent, genuine);
  return [a, b];
}
