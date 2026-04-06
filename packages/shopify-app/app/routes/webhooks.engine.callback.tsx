import type { ActionFunctionArgs } from "@remix-run/node";
import { updateSimulationFromCallback } from "../services/simulation.server";
import { incrementMtUsage } from "../services/store.server";
import db from "../db.server";

// Called by Auctovio engine (Groq) when a simulation phase completes
// Auth: Bearer token (ENGINE_API_KEY)
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verify engine secret — always required; fail closed if ENV is missing
  const authHeader = request.headers.get("Authorization");
  const expectedKey = process.env.ENGINE_API_KEY;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: {
    simulationId?: string;
    phase?: number;
    status?: string;
    score?: number;
    imageScore?: number;
    reportJson?: unknown;
    actualMtCost?: number;
    recommendations?: unknown[];
    trustAudit?: unknown;
    comparisonInsight?: string;
    productDna?: unknown;
    agentLogs?: {
      agentId: string;
      archetype: string;
      archetypeName?: string;
      archetypeEmoji?: string;
      personaName?: string;
      personaAge?: number;
      personaOccupation?: string;
      personaMotivation?: string;
      nicheConcern?: string;
      phase: number;
      verdict: string;
      reasoning: string;
    }[];
  };

  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const {
    simulationId, phase, status, score, imageScore,
    reportJson, agentLogs, actualMtCost, recommendations, trustAudit,
    comparisonInsight, productDna,
  } = body;

  if (!simulationId || typeof simulationId !== "string") {
    return new Response("Missing simulationId", { status: 400 });
  }

  const validStatuses = ["RUNNING", "COMPLETED", "FAILED"];
  if (!status || !validStatuses.includes(status)) {
    return new Response("Invalid status", { status: 400 });
  }

  // Update simulation record + insert agent logs
  await updateSimulationFromCallback(simulationId, {
    phase: phase ?? 0,
    status: status as "RUNNING" | "COMPLETED" | "FAILED",
    score,
    imageScore,
    reportJson,
    agentLogs,
    recommendations,
    trustAudit,
    comparisonInsight,
    productDna,
  });

  // Update MT usage when simulation completes
  if (status === "COMPLETED" && actualMtCost && typeof actualMtCost === "number") {
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
