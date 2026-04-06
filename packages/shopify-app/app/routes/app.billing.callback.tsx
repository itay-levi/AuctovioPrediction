import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { upgradePlanTier } from "../services/billing.server";
import type { BillingPlan } from "../services/billing.server";

// Shopify redirects here after merchant approves the subscription.
// SECURITY: We verify the subscription is ACTIVE via the Shopify API
// using the charge_id Shopify appends to the return URL — we never
// trust the ?plan= query param alone.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") as BillingPlan | null;
  const chargeId = url.searchParams.get("charge_id");

  if (!plan || !["PRO", "ENTERPRISE"].includes(plan)) {
    throw redirect("/app/billing");
  }

  if (!chargeId) {
    // No charge_id means Shopify didn't send us here — reject
    console.warn(`[Billing] Callback reached without charge_id for ${session.shop}`);
    throw redirect("/app/billing");
  }

  // Verify the subscription is genuinely ACTIVE via Shopify Admin API
  let isActive = false;
  try {
    const response = await admin.graphql(
      `query verifySubscription($id: ID!) {
        node(id: $id) {
          ... on AppSubscription {
            id
            status
          }
        }
      }`,
      { variables: { id: chargeId } },
    );

    const json = await response.json() as {
      data?: { node?: { status?: string } };
    };

    isActive = json.data?.node?.status === "ACTIVE";
  } catch (err) {
    console.error("[Billing] Subscription verification failed:", err);
  }

  if (!isActive) {
    console.warn(`[Billing] Subscription ${chargeId} is not ACTIVE for ${session.shop} — aborting upgrade`);
    throw redirect("/app/billing?error=payment_not_confirmed");
  }

  await upgradePlanTier(session.shop, plan);
  console.log(`[Billing] Upgraded ${session.shop} to ${plan} (subscription ${chargeId})`);

  throw redirect("/app?upgraded=1");
};

export default function BillingCallback() {
  return null;
}
