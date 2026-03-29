import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// MANDATORY GDPR webhook — required for Shopify App Store approval
// Shopify sends this 48 hours after a store uninstalls the app.
// We must delete all data associated with the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} received for ${shop} — purging all store data`);

  // Delete all store data in dependency order
  await db.$transaction(async (tx) => {
    // Find the store
    const store = await tx.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return; // Already deleted or never existed

    // Delete agent logs → simulations → competitors → store
    const simulations = await tx.simulation.findMany({
      where: { storeId: store.id },
      select: { id: true },
    });
    const simIds = simulations.map((s) => s.id);

    await tx.agentLog.deleteMany({ where: { simulationId: { in: simIds } } });
    await tx.simulation.deleteMany({ where: { storeId: store.id } });
    await tx.competitorWatch.deleteMany({ where: { storeId: store.id } });
    await tx.store.delete({ where: { id: store.id } });
  });

  return new Response();
};
