import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation, unlockSimulation } from "../services/simulation.server";

// Shopify redirects here after merchant approves the one-time unlock charge.
// SECURITY: We verify the charge is ACTIVE via the Shopify Admin API using
// the charge_id Shopify appends to the return URL — we never trust the
// simulationId or any query param alone, and we only mark the row unlocked
// once Shopify has confirmed the merchant paid.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const t0 = Date.now();
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const simulationId = url.searchParams.get("simulationId");
  const chargeId = url.searchParams.get("charge_id");
  console.info("[Unlock:callback_received]", {
    shopDomain,
    simulationId,
    hasChargeId: !!chargeId,
  });

  if (!simulationId) {
    console.warn("[Unlock:callback_missing_sim]", { shopDomain });
    throw redirect("/app/history?unlockError=missingSim");
  }
  if (!chargeId) {
    console.warn("[Unlock:callback_missing_charge]", { shopDomain, simulationId });
    throw redirect(`/app/results/${simulationId}?unlockError=missingCharge`);
  }

  // Validate the simulation belongs to this shop before doing anything.
  const [sim, store] = await Promise.all([
    getSimulation(simulationId),
    getStore(shopDomain),
  ]);
  if (!sim || !store || sim.storeId !== store.id) {
    console.warn("[Unlock:callback_sim_foreign]", {
      shopDomain,
      simulationId,
      simFound: !!sim,
      storeFound: !!store,
      ownerMatch: sim?.storeId === store?.id,
    });
    throw redirect("/app/history?unlockError=notFound");
  }

  // Verify the one-time purchase is ACTIVE via Shopify Admin API.
  let isActive = false;
  let shopifyStatus: string | undefined;
  try {
    const response = await admin.graphql(
      `query verifyOneTime($id: ID!) {
        node(id: $id) {
          ... on AppPurchaseOneTime {
            id
            status
          }
        }
      }`,
      { variables: { id: chargeId } },
    );

    const responseJson = (await response.json()) as {
      data?: { node?: { status?: string } };
    };

    shopifyStatus = responseJson.data?.node?.status;
    isActive = shopifyStatus === "ACTIVE";
    console.info("[Unlock:charge_verify]", {
      shopDomain,
      simulationId,
      chargeId,
      shopifyStatus,
      isActive,
    });
  } catch (err) {
    console.error("[Unlock:charge_verify_failed]", {
      chargeId,
      simulationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!isActive) {
    console.warn("[Unlock:charge_not_active]", {
      shopDomain,
      simulationId,
      chargeId,
      shopifyStatus,
    });
    throw redirect(`/app/results/${simulationId}?unlockError=notConfirmed`);
  }

  // Full panel runs for everyone regardless of tier, so unlocking is just
  // flipping the gate flag — no engine call needed.
  try {
    await unlockSimulation({ simulationId, chargeId, shopDomain });
    console.info("[Unlock:succeeded]", {
      shopDomain,
      simulationId,
      chargeId,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    console.error("[Unlock:mark_unlocked_failed]", {
      simulationId,
      chargeId,
      err: err instanceof Error ? err.message : String(err),
    });
    // Charge is already accepted; merchant lands on the results page either
    // way and support can flip the flag manually if needed.
  }

  throw redirect(`/app/results/${simulationId}?unlocked=1`);
};

export default function BillingUnlockCallback() {
  return null;
}
