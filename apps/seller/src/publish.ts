import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { ARTIFACT_DIGEST_COMMAND, TOOL_DIR, emit, loadSigningKey, signManifest, type OfferManifest, type SignedManifest } from "@polygraph/core";
import { UPSTREAM_DIR, mustSh, sh } from "./sandbox.js";

export const OFFER_NAME = "Document to PDF (LibreOffice)";
export const OFFER_DESCRIPTION =
  "Converts an office document (docx, odt, rtf, doc) to PDF with headless LibreOffice, in a fresh worker forked from a locked, tested parent sandbox.";
export const PRICE_USD = "0.50";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const OFFERS_DIR = join(repoRoot, "data/offers");

export type FoilKind = "lying-egress" | "tampered-artifact";

/** Removes caches, then hashes the packaged files with the same command the buyer runs in its worker. */
export async function computeDigest(sandbox: Sandbox): Promise<{ digest: string; files: string[] }> {
  await mustSh(sandbox, "clean caches", `find ${TOOL_DIR} -name __pycache__ -type d -prune -exec rm -rf {} + ; rm -rf ${TOOL_DIR}/.pytest_cache`);
  const listing = await mustSh(sandbox, "list files", `cd ${TOOL_DIR} && find . -type f | LC_ALL=C sort`);
  const digest = (await mustSh(sandbox, "digest", ARTIFACT_DIGEST_COMMAND)).stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`digest command printed something unexpected: ${digest}`);
  return { digest, files: listing.stdout.trim().split("\n") };
}

const LICENSE_HEADINGS: [RegExp, string][] = [
  [/^\s*MIT License/i, "MIT"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/Apache License\s+Version 2\.0/i, "Apache-2.0"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, "AGPL-3.0"],
  [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, "LGPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
  [/Mozilla Public License,? (Version|v\.) 2\.0/i, "MPL-2.0"],
  [/BSD 3-Clause|Redistribution and use in source and binary forms/i, "BSD-3-Clause"],
];

/** Reads the licence from the cloned upstream repository rather than trusting a hard-coded value. */
export async function readLicense(sandbox: Sandbox): Promise<string> {
  const result = await sh(sandbox, `f=$(ls ${UPSTREAM_DIR} | grep -i -m1 -E '^(licen[cs]e|copying)'); [ -n "$f" ] && head -c 4000 "${UPSTREAM_DIR}/$f"`);
  if (result.exitCode !== 0 || !result.stdout.trim()) return "unknown";
  const text = result.stdout;
  for (const [pattern, id] of LICENSE_HEADINGS) if (pattern.test(text)) return id;
  return text.trim().split("\n")[0]?.trim() ?? "unknown";
}

export function newOfferId(): string {
  return `offer_${randomBytes(6).toString("hex")}`;
}

/** Signs the manifest with the seller key, writes it where the gateway serves offers from, and announces it. */
export async function publishOffer(manifest: OfferManifest, foil?: FoilKind): Promise<SignedManifest> {
  const { privateKey, publicKey } = loadSigningKey();
  const signed = signManifest(manifest, privateKey, publicKey);
  await mkdir(OFFERS_DIR, { recursive: true });
  if (foil) {
    // The label lives only in the sidecar, which the gateway never serves: the buyer has to catch foils on evidence.
    await writeFile(join(OFFERS_DIR, `${manifest.offerId}.foil.json`), `${JSON.stringify({ foil }, null, 2)}\n`);
  }
  await writeFile(join(OFFERS_DIR, `${manifest.offerId}.json`), `${JSON.stringify(signed, null, 2)}\n`);
  await emit({ type: "offer.published", offer: signed });
  return signed;
}

export interface StoredOffer {
  signed: SignedManifest;
  /** Set when a sidecar marks the offer as a foil. */
  foil?: FoilKind;
}

/** Every offer on disk with its foil label, newest first. */
export async function listStoredOffers(): Promise<StoredOffer[]> {
  let names: string[];
  try {
    names = await readdir(OFFERS_DIR);
  } catch {
    return [];
  }
  const offers: StoredOffer[] = [];
  for (const name of names) {
    if (!name.startsWith("offer_") || !name.endsWith(".json") || name.endsWith(".foil.json")) continue;
    const signed = JSON.parse(await readFile(join(OFFERS_DIR, name), "utf8")) as SignedManifest;
    const sidecar = join(OFFERS_DIR, name.replace(/\.json$/, ".foil.json"));
    const foil = names.includes(basename(sidecar)) ? (JSON.parse(await readFile(sidecar, "utf8")) as { foil: FoilKind }).foil : undefined;
    offers.push({ signed, foil });
  }
  return offers.sort((a, b) => (a.signed.manifest.createdAt < b.signed.manifest.createdAt ? 1 : -1));
}

/** The genuine offer with this id, or the newest genuine offer when no id is given. */
export async function findGenuineOffer(offerId?: string): Promise<SignedManifest | undefined> {
  const genuine = (await listStoredOffers()).filter((offer) => !offer.foil);
  return (offerId ? genuine.find((offer) => offer.signed.manifest.offerId === offerId) : genuine[0])?.signed;
}

/** Finds the genuine offer previously published for a parent sandbox, so it can be republished without a rebuild. */
export async function findOfferForParent(parentSandboxId: string): Promise<SignedManifest | undefined> {
  return (await listStoredOffers()).find((offer) => !offer.foil && offer.signed.manifest.parentSandboxId === parentSandboxId)?.signed;
}

export async function removeOffer(offerId: string): Promise<void> {
  await rm(join(OFFERS_DIR, `${offerId}.json`), { force: true });
  await rm(join(OFFERS_DIR, `${offerId}.foil.json`), { force: true });
}
