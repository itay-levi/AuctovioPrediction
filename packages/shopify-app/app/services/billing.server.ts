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

/** Pay-per-scan one-time unlock for a single Customer Confidence Report. */
export const UNLOCK_REPORT = {
  name: "Customer Confidence Report — Full Unlock",
  price: "4.99",
  currency: "USD",
} as const;

export async function createSubscription(
  admin: AdminApiContext,
  plan: BillingPlan,
  returnUrl: string
): Promise<string> {
  const planConfig = PLANS[plan];
  const isTest = process.env.NODE_ENV !== "production";

  const response = await admin.graphql(`
    mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $trialDays: Int, $test: Boolean) {
      appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, trialDays: $trialDays, test: $test) {
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
      test: isTest,
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

interface AppPurchaseOneTimeCreateResponse {
  data: {
    appPurchaseOneTimeCreate: {
      userErrors: { field: string; message: string }[];
      confirmationUrl: string;
      appPurchaseOneTime: { id: string; status: string } | null;
    };
  };
}

/**
 * Create a Shopify one-time charge that unlocks the full report for a single
 * simulation. The merchant approves on Shopify's confirmation page, then is
 * redirected back to `returnUrl` with `?charge_id=…` which our callback route
 * verifies against the Shopify Admin API before flipping `simulation.unlockedAt`.
 */
export async function createReportUnlockCharge(
  admin: AdminApiContext,
  returnUrl: string,
): Promise<string> {
  const isTest = process.env.NODE_ENV !== "production";

  const response = await admin.graphql(
    `mutation appPurchaseOneTimeCreate($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
      appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
        userErrors { field message }
        confirmationUrl
        appPurchaseOneTime { id status }
      }
    }`,
    {
      variables: {
        name: UNLOCK_REPORT.name,
        price: { amount: UNLOCK_REPORT.price, currencyCode: UNLOCK_REPORT.currency },
        returnUrl,
        test: isTest,
      },
    },
  );

  const data = (await response.json()) as AppPurchaseOneTimeCreateResponse;
  const result = data?.data?.appPurchaseOneTimeCreate;
  if (!result) {
    throw new Error("Billing error: empty response from Shopify");
  }
  const errors = result.userErrors;
  if (errors.length > 0) {
    throw new Error(`Billing error: ${errors.map((e) => e.message).join(", ")}`);
  }
  return result.confirmationUrl;
}

/**
 * Mark a simulation as fully unlocked. Called after the unlock callback
 * verifies the charge is ACTIVE on Shopify. Idempotent — calling twice
 * doesn't double-unlock.
 */
export async function markSimulationUnlocked(
  simulationId: string,
  chargeId: string,
): Promise<void> {
  await db.simulation.update({
    where: { id: simulationId },
    data: {
      unlockedAt: new Date(),
      unlockChargeId: chargeId,
    } as Parameters<typeof db.simulation.update>[0]["data"],
  });
}
