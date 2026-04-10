import type { ActionFunctionArgs } from "@remix-run/node";
import { updateSimulationFromCallback } from "../services/simulation.server";
import { incrementMtUsage } from "../services/store.server";
import { evaluateRetake } from "../services/engine.server";
import db from "../db.server";

async function _triggerRetakeEvaluation(retakeSim: {
  id: string;
  originalSimulationId: string | null;
  score: number | null;
  reportJson: unknown;
}) {
  if (!retakeSim.originalSimulationId) return;

  const originalSim = await db.simulation.findUnique({
    where: { id: retakeSim.originalSimulationId },
    select: {
      score: true,
      recommendations: true,
      reportJson: true,
      productJson: true,
    },
  });
  if (!originalSim?.recommendations) return;

  const newReport = retakeSim.reportJson as { friction?: Record<string, unknown>; votes?: unknown[] } | null;
  const origReport = originalSim.reportJson as { friction?: Record<string, unknown> } | null;
  const newVotes = (newReport?.votes ?? []) as Record<string, unknown>[];
  const productTitle = (originalSim.productJson as { title?: string } | null)?.title ?? "Product";

  try {
    const evaluation = await evaluateRetake({
      productTitle,
      originalScore: originalSim.score ?? 0,
      newScore: retakeSim.score ?? 0,
      originalRecommendations: originalSim.recommendations as { lens: string; title: string; the_why?: string; impact?: string }[],
      originalFriction: (origReport?.friction ?? {}) as Record<string, unknown>,
      newFriction: (newReport?.friction ?? {}) as Record<string, unknown>,
      newVotes,
    });

    await db.simulation.update({
      where: { id: retakeSim.id },
      data: { retakeEvaluation: evaluation } as Parameters<typeof db.simulation.update>[0]["data"],
    });
  } catch (err) {
    console.error(`[Retake] Evaluation failed for ${retakeSim.id}:`, err);
  }
}

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
    failureReason?: string;
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
    comparisonInsight, productDna, failureReason,
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
    ...(failureReason && { failureReason }),
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

    // Trigger retake evaluation when a RETAKE simulation finishes
    if (sim?.simulationType === "RETAKE" && sim.originalSimulationId) {
      _triggerRetakeEvaluation(sim).catch(() => {});
    }
  }

  return new Response(null, { status: 200 });
};
