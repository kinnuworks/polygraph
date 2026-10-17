import { emit, type PurchaseGrant } from "@polygraph/core";
import { postJson } from "./http.js";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Tells the gateway a purchase is finished ("done") or should be refunded. Returns the gateway's
 * answer, or null when the call failed; a failure is reported as an event, never thrown.
 */
export async function tellGateway(gateway: string, grant: PurchaseGrant, action: "refund" | "done", reason?: string): Promise<unknown> {
  // The secret proves the call comes from the buyer; older gateways do not issue one.
  const headers: Record<string, string> = grant.purchaseSecret ? { "x-purchase-secret": grant.purchaseSecret } : {};
  try {
    const answer = await postJson(`${gateway}/purchases/${encodeURIComponent(grant.purchaseId)}/${action}`, reason ? { reason } : {}, headers);
    await emit({ type: "buyer.step", step: action === "refund" ? "refund-requested" : "released", detail: `${grant.purchaseId}${reason ? ` · ${reason}` : ""}` });
    return answer;
  } catch (err) {
    await emit({ type: "buyer.step", step: `${action}-failed`, detail: `${grant.purchaseId} · ${errorText(err)}` });
    return null;
  }
}
