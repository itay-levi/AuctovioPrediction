import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// MANDATORY GDPR webhook — required for Shopify App Store approval
// Shopify sends this when a customer requests their data.
// We store NO personal customer data (only product analysis), so we respond 200 OK.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} received for ${shop} — no customer PII stored`);
  return new Response();
};
