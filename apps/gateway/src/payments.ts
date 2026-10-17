import Stripe from "stripe";
import { Mppx, Store, stripe } from "mppx/server";
import { config } from "./config.js";

export const stripeClient = new Stripe(config.stripe.secretKey);

const machinePayments = stripe.create({
  client: stripeClient,
  networkId: config.stripe.profileId,
  livemode: !config.stripe.secretKey.includes("_test_"),
  store: Store.memory(),
});

export const mppx = Mppx.create({
  methods: machinePayments.defaultMethods({ exclude: ["tempo"] }),
  secretKey: config.stripe.mppSecretKey,
});

/** The one payment method in use: Stripe shared payment tokens (cards and Link). */
export const chargeCard = mppx["stripe/charge"];

/**
 * Refunds a payment in full. Stripe's reason codes describe a customer's request or fraud, which fits
 * neither a failed worker nor a failed check, so the reason goes in metadata instead.
 */
export async function refundPayment(paymentIntentId: string, reason: string): Promise<string> {
  const refund = await stripeClient.refunds.create({
    payment_intent: paymentIntentId,
    metadata: { polygraph_refund_reason: reason.slice(0, 500) },
  });
  return refund.id;
}

const METADATA_ATTEMPTS = 3;

/** Writes metadata onto the PaymentIntent, retrying with a short backoff. Throws after the last attempt. */
export async function tagPayment(paymentIntentId: string, metadata: Record<string, string>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await stripeClient.paymentIntents.update(paymentIntentId, { metadata });
      return;
    } catch (err) {
      if (attempt >= METADATA_ATTEMPTS) throw err;
      console.warn(`[payments] metadata update on ${paymentIntentId} failed (attempt ${attempt} of ${METADATA_ATTEMPTS}): ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}
