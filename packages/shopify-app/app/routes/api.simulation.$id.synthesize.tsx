import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import db from "../db.server";

const ENGINE_URL = process.env.ENGINE_URL;
const ENGINE_API_KEY = process.env.ENGINE_API_KEY;

function engineHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ENGINE_API_KEY) h["Authorization"] = `Bearer ${ENGINE_API_KEY}`;
  return h;
}

// POST /api/simulation/:id/synthesize
// Calls engine to generate a Compressed Intelligence Report, stores it, returns it.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);

  const isDev = process.env.NODE_ENV === "development";
  if (!store || (!isDev && store.planTier !== "PRO" && store.planTier !== "ENTERPRISE")) {
    return Response.json({ error: "Pro or Enterprise plan required" }, { status: 403 });
  }

  const simulation = await db.simulation.findUnique({
    where: { id: params.id! },
    include: { agentLogs: { orderBy: { createdAt: "asc" } } },
  });

  if (!simulation || simulation.storeId !== store.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const regenerate = formData.get("regenerate") === "1";

  // Return cached synthesis unless regenerate requested
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim = simulation as any;
  if (sim.synthesisText && !regenerate) {
    return Response.json({ synthesis: sim.synthesisText as string });
  }

  const productJson = simulation.productJson as { title?: string } | null;
  const productTitle = productJson?.title ?? "Unknown Product";

  const agentLogsPayload = simulation.agentLogs.map((l) => ({
    archetype: l.archetype,
    phase: l.phase,
    vote: l.verdict,
    reasoning: l.reasoning,
  }));

  if (!ENGINE_URL) {
    return Response.json({ error: "Engine not configured" }, { status: 500 });
  }

  let synthesis: string;
  try {
    const res = await fetch(`${ENGINE_URL}/miroshop/synthesize`, {
      method: "POST",
      headers: engineHeaders(),
      body: JSON.stringify({
        simulation_id: simulation.id,
        product_title: productTitle,
        niche: store.shopType ?? "general_retail",
        agent_logs: agentLogsPayload,
      }),
      signal: AbortSignal.timeout(120_000), // synthesis can take ~60s
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { synthesis: string };
    synthesis = data.synthesis;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Synthesis failed: ${msg}` }, { status: 500 });
  }

  // Store permanently (cast needed until Prisma client regenerates with new columns)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.simulation.update as any)({
    where: { id: simulation.id },
    data: { synthesisText: synthesis, synthesisGeneratedAt: new Date() },
  });

  return Response.json({ synthesis });
};
