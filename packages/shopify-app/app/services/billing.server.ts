import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../db.server";

export const PLANS = {
  PRO: {
    name: "CustomerPanel AI — Pro",
    price: "29.90",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 7,
  },
  ENTERPRISE: {
    name: "CustomerPanel AI — Enterprise",
    price: "89.00",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 7,
  },
} as const;

export type BillingPlan = keyof typeof PLANS;

export async function createSubscription(
  admin: AdminApiContext,
  plan: BillingPlan,
  returnUrl: string
): Promise<string> {
  const planConfig = PLANS[plan];

  const response = await admin.graphql(`
    mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $trialDays: Int) {
      appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, trialDays: $trialDays) {
        userErrors { field message }
        confirmationUrl
        appSubscription { id status }
      }
    }
  `, {
    variables: {
      name: planConfig.name,
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: planConfig.price, currencyCode: "USD" },
            interval: planConfig.interval,
          },
        },
      }],
      returnUrl,
      trialDays: planConfig.trialDays,
    },
  });

  const data = await response.json() as {
    data: {
      appSubscriptionCreate: {
        userErrors: { field: string; message: string }[];
        confirmationUrl: string;
      };
    };
  };

  const errors = data.data.appSubscriptionCreate.userErrors;
  if (errors.length > 0) {
    throw new Error(`Billing error: ${errors.map((e) => e.message).join(", ")}`);
  }

  return data.data.appSubscriptionCreate.confirmationUrl;
}

export async function upgradePlanTier(shopDomain: string, plan: BillingPlan) {
  await db.store.update({
    where: { shopDomain },
    data: { planTier: plan },
  });
}

export async function cancelSubscription(shopDomain: string) {
  await db.store.update({
    where: { shopDomain },
    data: { planTier: "FREE", mtBudgetUsed: 0 },
  });
}
