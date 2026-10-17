import { parseArgs } from "node:util";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { emit, type OfferManifest } from "@polygraph/core";
import { acceptanceLoop } from "./acceptance.js";
import { buildTool, provision } from "./build.js";
import { createFoils } from "./foils.js";
import { harden } from "./harden.js";
import { modelName } from "./llm.js";
import { OFFER_DESCRIPTION, OFFER_NAME, PRICE_USD, computeDigest, findOfferForParent, newOfferId, publishOffer, readLicense } from "./publish.js";
import { ROOTFS, SHAPE, SandboxRegistry, createClient, pauseAndWait, requireEnv } from "./sandbox.js";

const USAGE = `usage: npm run seller -- [options]
  --repo <url>          upstream repository to package (default https://github.com/unoconv/unoserver)
  --skip-build <id>     reuse an existing paused parent sandbox and republish its offer
  --foils               with --skip-build: only create the two test foils, do not republish
  --no-foils            do not create the test foils
  --keep                never destroy sandboxes on exit, even after a failure`;

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "https://github.com/unoconv/unoserver" },
    "skip-build": { type: "string" },
    foils: { type: "boolean", default: false },
    "no-foils": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.foils && !values["skip-build"]) {
  console.error("--foils needs --skip-build <parentSandboxId>\n" + USAGE);
  process.exit(2);
}
requireEnv("ANTHROPIC_API_KEY");
requireEnv("SELLER_SIGNING_KEY");

const registry = new SandboxRegistry(createClient());

async function shutdown(failed: boolean): Promise<void> {
  if (values.keep) {
    console.log(`--keep: leaving ${registry.describe().join(", ") || "no sandboxes"}`);
    return;
  }
  await registry.cleanup(failed);
}

process.once("SIGINT", () => {
  console.error("interrupted; cleaning up");
  void shutdown(true).finally(() => process.exit(130));
});

/** Steps 1 to 6: provision, write, test and fix, harden, acceptance, package, publish. */
async function buildAndPublish(repo: string): Promise<{ parent: Sandbox; manifest: OfferManifest }> {
  await emit({ type: "seller.step", step: "provision", detail: `creating ${SHAPE} ${ROOTFS} sandbox (model ${modelName})` });
  const parent = await registry.create("parent", { shape: SHAPE, rootfs: ROOTFS });
  await emit({ type: "seller.step", step: "provision", detail: `sandbox ${parent.id} running, egress open for setup` });

  await provision(parent, repo);
  const build = await buildTool(parent, repo);
  const hardened = await harden(parent, build.workspace, build.facts);
  const acceptance = await acceptanceLoop(parent, build.workspace, build.facts);

  const { digest, files } = await computeDigest(parent);
  await emit({ type: "seller.step", step: "package", detail: `artifactDigest ${digest} over ${files.length} files: ${files.join(" ")}` });
  const license = await readLicense(parent);

  await emit({ type: "seller.step", step: "publish", detail: `pausing parent ${parent.id}` });
  await pauseAndWait(parent);
  registry.keep(parent);

  const manifest: OfferManifest = {
    offerId: newOfferId(),
    name: OFFER_NAME,
    description: OFFER_DESCRIPTION,
    source: { repo, license },
    parentSandboxId: parent.id,
    egress: hardened.egress,
    artifactDigest: digest,
    priceUsd: PRICE_USD,
    checks: [...hardened.checks, acceptance],
    createdAt: new Date().toISOString(),
  };
  await publishOffer(manifest);
  await emit({ type: "seller.step", step: "publish", detail: `offer ${manifest.offerId} published for parent ${parent.id}` });
  return { parent, manifest };
}

/** Reuses a paused parent: confirms it with the platform and signs a fresh copy of its last genuine offer. */
async function reuseParent(parentId: string, republish: boolean): Promise<{ parent: Sandbox; manifest: OfferManifest }> {
  const parent = await registry.client.getSandbox(parentId);
  if (parent.status !== "paused") throw new Error(`parent ${parentId} is ${parent.status}, expected paused`);
  const previous = await findOfferForParent(parentId);
  if (!previous) throw new Error(`no genuine offer in data/offers for parent ${parentId}; run a full build instead`);
  const platformEgress = (await parent.getEgress()).egress ?? [];
  if (platformEgress.join(",") !== previous.manifest.egress.join(",")) {
    throw new Error(`parent egress [${platformEgress.join(", ")}] no longer matches the offer's [${previous.manifest.egress.join(", ")}]`);
  }
  if (!republish) return { parent, manifest: previous.manifest };
  const manifest: OfferManifest = { ...previous.manifest, offerId: newOfferId(), createdAt: new Date().toISOString() };
  await publishOffer(manifest);
  await emit({ type: "seller.step", step: "publish", detail: `offer ${manifest.offerId} republished for parent ${parentId}` });
  return { parent, manifest };
}

let failed = true;
try {
  const parentId = values["skip-build"];
  const { parent, manifest } = parentId ? await reuseParent(parentId, !values.foils) : await buildAndPublish(values.repo);
  if (!values["no-foils"]) {
    const foils = await createFoils(registry, parent, manifest);
    for (const foil of foils) {
      await emit({ type: "seller.step", step: "foil", detail: `${foil.manifest.name}: offer ${foil.manifest.offerId}, parent ${foil.manifest.parentSandboxId}` });
    }
  }
  failed = false;
} catch (err) {
  await emit({ type: "seller.step", step: "failed", detail: (err as Error).message });
  console.error(err);
} finally {
  await shutdown(failed);
  console.log(`kept sandboxes: ${registry.describe().join(", ") || "none"}`);
}
process.exit(failed ? 1 : 0);
