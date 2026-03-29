import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { upgradePlanTier } from "../services/billing.server";
import type { BillingPlan } from "../services/billing.server";

// Shopify redirects here after merchant approves the subscription
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") as BillingPlan | null;

  if (plan === "PRO" || plan === "ENTERPRISE") {
    await upgradePlanTier(session.shop, plan);
  }

  throw redirect("/app?upgraded=1");
};

export default function BillingCallback() {
  return null;
}
