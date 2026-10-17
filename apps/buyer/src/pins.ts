import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@polygraph/core";

interface Pin {
  fingerprint: string;
  pinnedAt: string;
  /** Offer whose signature introduced the key. */
  firstOffer: string;
}

/** RFC 7638 thumbprint of the seller's JWK, shown as "SHA256:<base64url>". */
export function keyFingerprint(jwk: JsonWebKey): string {
  const members = jwk.kty === "OKP" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x } : jwk;
  return `SHA256:${createHash("sha256").update(canonicalJson(members)).digest("base64url")}`;
}

export const shortFingerprint = (fingerprint: string) => `${fingerprint.slice(0, 23)}…`;

export type PinResult =
  | { status: "match"; pin: Pin }
  | { status: "mismatch"; pin: Pin }
  | { status: "pinned-now"; pin: Pin }
  | { status: "unpinned" };

/**
 * Trust on first use for seller keys, one key per gateway origin, kept in a small JSON file.
 * With `trustNew`, the first key seen for an origin is pinned; afterwards any other key fails.
 */
export class SellerPins {
  private constructor(
    private readonly file: string,
    private readonly pins: Record<string, Pin>,
    private readonly trustNew: boolean,
  ) {}

  static async load(file: string, trustNew: boolean): Promise<SellerPins> {
    try {
      return new SellerPins(file, JSON.parse(await readFile(file, "utf8")) as Record<string, Pin>, trustNew);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${(err as Error).message}`);
      return new SellerPins(file, {}, trustNew);
    }
  }

  async check(gateway: string, offerId: string, fingerprint: string): Promise<PinResult> {
    const origin = new URL(gateway).origin;
    const pin = this.pins[origin];
    if (pin) return { status: pin.fingerprint === fingerprint ? "match" : "mismatch", pin };
    if (!this.trustNew) return { status: "unpinned" };

    const created: Pin = { fingerprint, pinnedAt: new Date().toISOString(), firstOffer: offerId };
    this.pins[origin] = created;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.pins, null, 2)}\n`);
    return { status: "pinned-now", pin: created };
  }
}
