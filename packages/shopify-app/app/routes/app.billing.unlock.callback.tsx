import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation } from "../services/simulation.server";
import { markSimulationUnlocked } from "../services/billing.server";

// Shopify redirects here after merchant approves the one-time unlock charge.
// SECURITY: We verify the charge is ACTIVE via the Shopify Admin API using
// the charge_id Shopify appends to the return URL — we never trust the
// simulationId or any query param alone, and we only mark the row unlocked
// once Shopify has confirmed the merchant paid.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const simulationId = url.searchParams.get("simulationId");
  const chargeId = url.searchParams.get("charge_id");

  if (!simulationId) {
    throw redirect("/app/history?unlockError=missingSim");
  }
  if (!chargeId) {
    // No charge_id means Shopify didn't actually send us here — reject.
    console.warn(`[Unlock] Callback reached without charge_id for ${shopDomain}`);
    throw redirect(`/app/results/${simulationId}?unlockError=missingCharge`);
  }

  // Validate the simulation belongs to this shop before doing anything.
  const [sim, store] = await Promise.all([
    getSimulation(simulationId),
    getStore(shopDomain),
  ]);
  if (!sim || !store || sim.storeId !== store.id) {
    throw redirect("/app/history?unlockError=notFound");
  }

  // Verify the one-time purchase is ACTIVE via Shopify Admin API.
  let isActive = false;
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

    isActive = responseJson.data?.node?.status === "ACTIVE";
  } catch (err) {
    console.error("[Unlock] Charge verification failed", {
      chargeId,
      simulationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!isActive) {
    console.warn(
      `[Unlock] Charge ${chargeId} is not ACTIVE for ${shopDomain} — aborting unlock`,
    );
    throw redirect(`/app/results/${simulationId}?unlockError=notConfirmed`);
  }

  await markSimulationUnlocked(simulationId, chargeId);
  console.info("[Unlock] simulation unlocked", { simulationId, chargeId, shopDomain });

  throw redirect(`/app/results/${simulationId}?unlocked=1`);
};

export default function BillingUnlockCallback() {
  return null;
}
