import { redirect } from "@remix-run/node";
import type { PlanTier } from "@prisma/client";
import { getStore } from "./store.server";

const TIER_ORDER: Record<PlanTier, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };

export const FEATURE_LABELS: Record<string, string> = {
  sandbox:   "What-If Sandbox requires a Pro or Enterprise plan.",
  synthesis: "Compressed Intelligence Reports require a Pro or Enterprise plan.",
  lab:       "Customer Lab scenarios require a Pro or Enterprise plan.",
};

export async function requireTier(
  shopDomain: string,
  minimum: PlanTier,
  feature?: keyof typeof FEATURE_LABELS,
): Promise<void> {
  // In development, bypass all billing gates so every feature is accessible
  if (process.env.NODE_ENV === "development") return;

  const store = await getStore(shopDomain);
  const current = store?.planTier ?? "FREE";
  if (TIER_ORDER[current] < TIER_ORDER[minimum]) {
    const qs = feature ? `?feature=${feature}` : "";
    throw redirect(`/app/billing${qs}`);
  }
}
