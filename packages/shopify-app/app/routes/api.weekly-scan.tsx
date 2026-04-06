import type { ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { computeShopHealthScore } from "../services/health-score.server";
import { sendWeeklyDigest } from "../services/email.server";

const CRON_SECRET = process.env.CRON_SECRET;

// POST /api/weekly-scan
// Called by external cron (e.g. Upstash QStash, Vercel cron, or curl)
// Header: Authorization: Bearer <CRON_SECRET>
export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = request.headers.get("Authorization");
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Find ENTERPRISE stores not scanned in the last 7 days
  const stores = await db.store.findMany({
    where: {
      planTier: "ENTERPRISE",
      OR: [
        { lastWeeklyScan: null },
        { lastWeeklyScan: { lt: oneWeekAgo } },
      ],
    },
    select: { id: true, shopDomain: true, accessToken: true },
  });

  const results: { shop: string; status: string }[] = [];

  for (const store of stores) {
    try {
      const { healthScore, simulationCount, topFriction } = await computeShopHealthScore(store.id);

      // Fetch recent completed sims for product list
      const recentSims = await db.simulation.findMany({
        where: { storeId: store.id, status: "COMPLETED", score: { not: null } },
        orderBy: { score: "desc" },
        take: 5,
        select: { productUrl: true, score: true },
      });

      const topProducts = recentSims.map((s) => ({
        name: s.productUrl.split("/").pop() ?? s.productUrl,
        score: s.score!,
      }));

      // Get shop owner email from Sessions (Shopify stores it there)
      const session = await db.session.findFirst({
        where: { shop: store.shopDomain, accountOwner: true },
        select: { email: true },
      });

      if (session?.email) {
        await sendWeeklyDigest(session.email, store.shopDomain, {
          healthScore,
          simulationCount,
          topFriction,
          topProducts,
        });
      }

      await db.store.update({
        where: { id: store.id },
        data: { healthScore, lastWeeklyScan: new Date() },
      });

      results.push({ shop: store.shopDomain, status: "sent" });
    } catch (err) {
      results.push({ shop: store.shopDomain, status: `error: ${String(err)}` });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
