import type { ActionFunctionArgs } from "@remix-run/node";
import { updateSimulationFromCallback } from "../services/simulation.server";
import { incrementMtUsage } from "../services/store.server";
import db from "../db.server";

// Called by MiroFish engine on Hetzner when a simulation phase completes
// Auth: Bearer token (ENGINE_API_KEY)
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verify engine secret
  const authHeader = request.headers.get("Authorization");
  const expectedKey = process.env.ENGINE_API_KEY;
  if (expectedKey && authHeader !== `Bearer ${expectedKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    simulationId: string;
    phase: number;
    status: "RUNNING" | "COMPLETED" | "FAILED";
    score?: number;
    imageScore?: number;
    reportJson?: unknown;
    actualMtCost?: number;
    agentLogs?: {
      agentId: string;
      archetype: string;
      phase: number;
      verdict: string;
      reasoning: string;
    }[];
  };

  const { simulationId, phase, status, score, imageScore, reportJson, agentLogs, actualMtCost } = body;

  if (!simulationId) {
    return new Response("Missing simulationId", { status: 400 });
  }

  // Update simulation record + insert agent logs
  await updateSimulationFromCallback(simulationId, {
    phase,
    status,
    score,
    imageScore,
    reportJson,
    agentLogs,
  });

  // Update MT usage when simulation completes
  if (status === "COMPLETED" && actualMtCost) {
    const sim = await db.simulation.findUnique({
      where: { id: simulationId },
      include: { store: { select: { shopDomain: true } } },
    });
    if (sim?.store?.shopDomain) {
      await incrementMtUsage(sim.store.shopDomain, actualMtCost);
    }
  }

  return new Response(null, { status: 200 });
};
