import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { cancelSubscription } from "../services/billing.server";

// Handles subscription cancellation and downgrades from Shopify
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    return new Response("Unhandled topic", { status: 422 });
  }

  const data = payload as { app_subscription?: { status?: string } };
  const status = data.app_subscription?.status;

  // CANCELLED, DECLINED, EXPIRED → downgrade to FREE
  if (status && ["CANCELLED", "DECLINED", "EXPIRED"].includes(status)) {
    await cancelSubscription(shop);
  }

  return new Response("ok", { status: 200 });
};
