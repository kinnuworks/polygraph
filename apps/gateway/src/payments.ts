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

const PRICE = /^\d{1,4}(\.\d{1,2})?$/;

/** Uses the manifest price when it is a plain dollar amount at or above the card minimum. */
export function priceFor(priceUsd: string | undefined): string {
  if (priceUsd && PRICE.test(priceUsd) && Number(priceUsd) >= Number(config.defaultPriceUsd)) return priceUsd;
  return config.defaultPriceUsd;
}

export async function refundPayment(paymentIntentId: string, reason: string): Promise<string> {
  const refund = await stripeClient.refunds.create({
    payment_intent: paymentIntentId,
    reason: "requested_by_customer",
    metadata: { polygraphReason: reason.slice(0, 500) },
  });
  return refund.id;
}

export async function tagPayment(paymentIntentId: string, metadata: Record<string, string>): Promise<void> {
  await stripeClient.paymentIntents.update(paymentIntentId, { metadata });
}
