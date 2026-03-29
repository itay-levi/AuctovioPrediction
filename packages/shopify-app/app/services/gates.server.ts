import { redirect } from "@remix-run/node";
import type { PlanTier } from "@prisma/client";
import { getStore } from "./store.server";

const TIER_ORDER: Record<PlanTier, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };

export async function requireTier(shopDomain: string, minimum: PlanTier): Promise<void> {
  const store = await getStore(shopDomain);
  const current = store?.planTier ?? "FREE";
  if (TIER_ORDER[current] < TIER_ORDER[minimum]) {
    throw redirect("/app/billing");
  }
}
