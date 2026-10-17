import { parseArgs } from "node:util";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { emit, type AcceptanceRecord, type OfferManifest } from "@polygraph/core";
import { acceptanceLoop, sealSuite } from "./acceptance.js";
import { buildTool, provision } from "./build.js";
import { FOIL_KIND, createFoils, publishTampered, type Tampering } from "./foils.js";
import { harden } from "./harden.js";
import { MODELS } from "./llm.js";
import {
  OFFER_DESCRIPTION,
  OFFER_NAME,
  PRICE_USD,
  computeDigest,
  findGenuineOffer,
  findOfferForParent,
  listStoredOffers,
  newOfferId,
  publishOffer,
  readLicense,
  removeOffer,
} from "./publish.js";
import { ROOTFS, SHAPE, SandboxRegistry, createClient, destroyById, pauseAndWait, requireEnv } from "./sandbox.js";

const USAGE = `usage: npm run seller -- [options]
  --repo <url>          upstream repository to package (default https://github.com/unoconv/unoserver)
  --skip-build <id>     reuse an existing paused parent sandbox and republish its offer
  --foils               with --skip-build: only create the two test foils, do not republish
  --no-foils            do not create the test foils
  --tamper <kind>       live demo: publish a tampered copy of the genuine offer (egress or artifact),
                        replacing the existing foil of the same kind
  --from <offerId>      with --tamper: the genuine offer to copy (default: the newest)
  --keep                never destroy sandboxes on exit, even after a failure`;

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "https://github.com/unoconv/unoserver" },
    "skip-build": { type: "string" },
    foils: { type: "boolean", default: false },
    "no-foils": { type: "boolean", default: false },
    tamper: { type: "string" },
    from: { type: "string" },
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
if (values.tamper !== undefined && values.tamper !== "egress" && values.tamper !== "artifact") {
  console.error("--tamper takes egress or artifact\n" + USAGE);
  process.exit(2);
}
if (values.tamper === undefined) requireEnv("ANTHROPIC_API_KEY");
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
  // Sealed before any sandbox exists or any code is written, so the suite provably predates the work.
  const suite = await sealSuite();
  await emit({ type: "seller.step", step: "acceptance", detail: `acceptance suite sealed before any code is written: ${suite.digest}` });
  await emit({ type: "seller.step", step: "provision", detail: `creating ${SHAPE} ${ROOTFS} sandbox (drafting ${MODELS.draft}, fixing ${MODELS.fix})` });
  const parent = await registry.create("parent", { shape: SHAPE, rootfs: ROOTFS });
  await emit({ type: "seller.step", step: "provision", detail: `sandbox ${parent.id} running, egress open for setup` });

  await provision(parent, repo);
  const build = await buildTool(parent, repo);
  const hardened = await harden(parent, build.workspace, build.facts);
  const acceptance = await acceptanceLoop(parent, build.workspace, build.facts, suite);

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
    checks: [...hardened.checks, acceptance.check],
    acceptance: acceptance.record,
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
  const acceptance = previous.manifest.acceptance ?? (await backfillAcceptance(previous.manifest));
  const manifest: OfferManifest = { ...previous.manifest, acceptance, offerId: newOfferId(), createdAt: new Date().toISOString() };
  await publishOffer(manifest);
  await removeOffer(previous.manifest.offerId);
  await emit({
    type: "seller.step",
    step: "publish",
    detail: `offer ${manifest.offerId} republished for parent ${parentId}, replacing ${previous.manifest.offerId}`,
  });
  return { parent, manifest };
}

/**
 * For offers published before manifests carried an acceptance record: the digest of the suite as
 * committed now, with the result of that offer's own acceptance check. `ranAt` is the old offer's
 * publish time, which followed the acceptance run within seconds.
 */
async function backfillAcceptance(previous: OfferManifest): Promise<AcceptanceRecord | undefined> {
  const check = previous.checks.find((c) => c.id === "acceptance");
  const passed = Number(check?.detail?.match(/^(\d+) passed/)?.[1]);
  if (check?.status !== "pass" || !Number.isFinite(passed)) return undefined;
  const suite = await sealSuite();
  await emit({ type: "seller.step", step: "acceptance", detail: `suite digest ${suite.digest}, last result ${passed} passed, 0 failed` });
  return { suiteDigest: suite.digest, passed, failed: 0, ranAt: previous.createdAt };
}

const LIVE_TAMPER_NAME = "Document to PDF (tampered live)";

/**
 * Live demo: forks the genuine offer's parent, tampers with it for real and publishes a signed offer that
 * still claims the genuine values. The existing foil of the same kind is removed first, so the number of
 * paused sandboxes stays the same under the account quota.
 */
async function tamperLive(tampering: Tampering, fromOfferId: string | undefined): Promise<void> {
  const started = Date.now();
  const genuine = await findGenuineOffer(fromOfferId);
  if (!genuine) throw new Error(fromOfferId ? `no genuine offer ${fromOfferId} in data/offers` : "no genuine offer in data/offers");
  const parent = await registry.client.getSandbox(genuine.manifest.parentSandboxId);
  if (parent.status !== "paused") throw new Error(`genuine parent ${parent.id} is ${parent.status}, expected paused`);

  const stored = await listStoredOffers();
  const protectedIds = new Set(stored.filter((offer) => !offer.foil).map((offer) => offer.signed.manifest.parentSandboxId));
  for (const old of stored.filter((offer) => offer.foil === FOIL_KIND[tampering])) {
    const { offerId, parentSandboxId, name } = old.signed.manifest;
    if (protectedIds.has(parentSandboxId)) throw new Error(`refusing to destroy ${parentSandboxId}: it backs a genuine offer`);
    // Withdraw the offer before its sandbox goes, so nothing is served that points at a dead parent.
    await removeOffer(offerId);
    await destroyById(registry.client, parentSandboxId);
    await emit({ type: "seller.step", step: "tamper", detail: `withdrew ${name} (${offerId}) and destroyed ${parentSandboxId}` });
  }

  await emit({ type: "seller.step", step: "tamper", detail: `forking genuine parent ${parent.id} to tamper with its ${tampering}` });
  const signed = await publishTampered(registry, parent, genuine.manifest, tampering, LIVE_TAMPER_NAME);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  await emit({ type: "seller.step", step: "tamper", detail: `published ${signed.manifest.offerId} in ${seconds} s, claiming the genuine offer's values` });
  console.log(`tampered offer: ${signed.manifest.offerId}`);
}

/** The normal run: build and publish (or reuse a parent), then the standing foils. */
async function sellerRun(): Promise<void> {
  const parentId = values["skip-build"];
  const { parent, manifest } = parentId ? await reuseParent(parentId, !values.foils) : await buildAndPublish(values.repo);
  if (!values["no-foils"]) {
    const foils = await createFoils(registry, parent, manifest);
    for (const foil of foils) {
      await emit({ type: "seller.step", step: "foil", detail: `${foil.manifest.name}: offer ${foil.manifest.offerId}, parent ${foil.manifest.parentSandboxId}` });
    }
  }
}

let failed = true;
try {
  if (values.tamper !== undefined) await tamperLive(values.tamper as Tampering, values.from);
  else await sellerRun();
  failed = false;
} catch (err) {
  await emit({ type: "seller.step", step: "failed", detail: (err as Error).message });
  console.error(err);
} finally {
  await shutdown(failed);
  console.log(`kept sandboxes: ${registry.describe().join(", ") || "none"}`);
}
process.exit(failed ? 1 : 0);
