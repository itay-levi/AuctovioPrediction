import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation, isReportUnlocked } from "../services/simulation.server";
import { createReportUnlockCharge } from "../services/billing.server";

// GET: not used directly — redirect back to billing.
export const loader = async () => {
  throw redirect("/app/billing");
};

// POST /app/billing/unlock
// Body: { simulationId: string }
// Creates a Shopify one-time charge of $4.99 to unlock the full report for
// the given simulation. Returns { confirmationUrl } so the client can navigate.
export const action = async ({ request }: ActionFunctionArgs) => {
  const t0 = Date.now();
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const simulationId = formData.get("simulationId");
  if (typeof simulationId !== "string" || !simulationId) {
    console.warn("[Unlock:bad_request_missing_sim]", { shopDomain });
    return json({ error: "Missing simulationId" }, { status: 400 });
  }
  console.info("[Unlock:started]", { shopDomain, simulationId });

  // Validate the simulation belongs to this shop before billing the merchant.
  const [sim, store] = await Promise.all([
    getSimulation(simulationId),
    getStore(shopDomain),
  ]);
  if (!sim || !store || sim.storeId !== store.id) {
    console.warn("[Unlock:sim_not_found_or_foreign]", {
      shopDomain,
      simulationId,
      simFound: !!sim,
      storeFound: !!store,
      ownerMatch: sim?.storeId === store?.id,
    });
    return json({ error: "Simulation not found" }, { status: 404 });
  }

  // Already unlocked (or merchant is on Pro/Enterprise) — no charge needed.
  if (isReportUnlocked(sim as unknown as { unlockedAt?: Date | string | null }, store.planTier)) {
    console.info("[Unlock:already_unlocked]", {
      shopDomain,
      simulationId,
      tier: store.planTier,
    });
    return json({ confirmationUrl: null, alreadyUnlocked: true });
  }

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  // Shopify will redirect here with ?charge_id=… on approval. The callback
  // route verifies the charge is ACTIVE then flips simulation.unlockedAt.
  const returnUrl = `${appUrl}/app/billing/unlock/callback?simulationId=${encodeURIComponent(simulationId)}`;

  try {
    const confirmationUrl = await createReportUnlockCharge(admin, returnUrl);
    console.info("[Unlock:charge_created]", {
      shopDomain,
      simulationId,
      hasConfirmationUrl: !!confirmationUrl,
      totalMs: Date.now() - t0,
    });
    return json({ confirmationUrl });
  } catch (err) {
    console.error("[Unlock:charge_create_failed]", {
      shopDomain,
      simulationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return json(
      { error: "Could not start the unlock checkout. Please try again." },
      { status: 500 },
    );
  }
};

// Default export so Remix doesn't complain — this route is action-only.
export default function BillingUnlock() {
  return null;
}
// Loader signature is unused at the moment but keeps the route type-safe
// in case we later want to inspect the LoaderFunctionArgs request URL.
export type { LoaderFunctionArgs };
