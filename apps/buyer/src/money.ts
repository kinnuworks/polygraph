const DOLLARS = /^\d+(\.\d{1,2})?$/;

/** "0.50" -> 50. Rejects anything that is not a plain dollar amount, so a malformed price never reaches a payment. */
export function usdToCents(usd: string): number {
  if (!DOLLARS.test(usd)) throw new Error(`not a dollar amount: ${JSON.stringify(usd)}`);
  const [whole, fraction = ""] = usd.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export const centsToUsd = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
