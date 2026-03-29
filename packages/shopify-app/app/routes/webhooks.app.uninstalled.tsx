import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Delete Shopify sessions
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Mark store as inactive (full data purge happens via shop/redact 48h later)
  await db.store
    .updateMany({
      where: { shopDomain: shop },
      data: { accessToken: "" },
    })
    .catch(() => {
      // Store may not exist if install failed mid-way
    });

  return new Response();
};
