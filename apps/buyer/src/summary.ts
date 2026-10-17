export type Outcome = "refused before payment" | "payment declined" | "refunded" | "failed" | "completed" | "not needed";

export interface OfferRow {
  offerId: string;
  priceUsd: string;
  outcome: Outcome;
  evidence: string;
}

export interface RunSummary {
  offers: OfferRow[];
  /** Key/value lines about the completed job, empty when no job ran. */
  job: [string, string][];
}

const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

/** Plain aligned columns; long cells are clipped to `maxCell` so rows stay on one line. */
function table(headers: string[], rows: string[][], maxCell: number): string {
  const cells = [headers, ...rows].map((row) => row.map((cell) => clip(cell, maxCell)));
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const rule = widths.map((w) => "─".repeat(w)).join("  ");
  const [head, ...body] = cells;
  return [line(head ?? []), rule, ...body.map(line)].join("\n");
}

export function printSummary(summary: RunSummary): void {
  const offers = summary.offers.map((row) => [row.offerId, `$${row.priceUsd}`, row.outcome, row.evidence]);
  console.log(`\nOffers\n${table(["offer", "price", "outcome", "evidence"], offers, 72)}`);
  if (summary.job.length > 0) console.log(`\nJob\n${table(["field", "value"], summary.job, 120)}`);
  console.log("");
}
