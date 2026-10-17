import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { OfferManifest, SignedManifest } from "./types.js";

/** Deterministic JSON: object keys sorted at every depth, so signatures are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/** Loads the seller key from SELLER_SIGNING_KEY (PKCS8 PEM, base64) or makes an ephemeral one. */
export function loadSigningKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  const encoded = process.env.SELLER_SIGNING_KEY;
  if (encoded) {
    const privateKey = createPrivateKey(Buffer.from(encoded, "base64").toString("utf8"));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  return generateKeyPairSync("ed25519");
}

export function signManifest(manifest: OfferManifest, privateKey: KeyObject, publicKey: KeyObject): SignedManifest {
  const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "polygraph-offer+jws" }));
  const payload = b64u(canonicalJson(manifest));
  const signature = b64u(sign(null, Buffer.from(`${header}.${payload}`), privateKey));
  return { manifest, jws: `${header}.${payload}.${signature}`, publicKey: publicKey.export({ format: "jwk" }) };
}

/** Checks that the JWS is valid for the embedded key and that it covers exactly this manifest. */
export function verifyManifest(signed: SignedManifest): { valid: boolean; reason?: string } {
  const parts = signed.jws.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed signature" };
  const [header, payload, signature] = parts as [string, string, string];
  let key: KeyObject;
  try {
    key = createPublicKey({ key: signed.publicKey as any, format: "jwk" });
  } catch {
    return { valid: false, reason: "unreadable public key" };
  }
  const ok = verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"));
  if (!ok) return { valid: false, reason: "signature does not match" };
  if (Buffer.from(payload, "base64url").toString("utf8") !== canonicalJson(signed.manifest)) {
    return { valid: false, reason: "signed payload differs from the manifest shown" };
  }
  return { valid: true };
}
