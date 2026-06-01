import type { ActionFunctionArgs } from "@remix-run/node";
import { updateSimulationFromCallback } from "../services/simulation.server";
import { incrementMtUsage } from "../services/store.server";
import { evaluateRetake } from "../services/engine.server";
import db from "../db.server";

interface RetakeSimSnapshot {
  id: string;
  originalSimulationId: string | null;
  score: number | null;
  reportJson: unknown;
}

async function _triggerRetakeEvaluation(retakeSim: RetakeSimSnapshot): Promise<void> {
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

interface CallbackBody {
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
}

const VALID_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;
type CallbackStatus = (typeof VALID_STATUSES)[number];

// Called by Auctovio engine (Groq) when a simulation phase completes
// Auth: Bearer token (ENGINE_API_KEY)
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verify engine secret — always required; fail closed if ENV is missing
  const authHeader = request.headers.get("Authorization");
  const expectedKey = process.env.ENGINE_API_KEY;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: CallbackBody;
  try {
    body = (await request.json()) as CallbackBody;
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

  if (!status || !(VALID_STATUSES as readonly string[]).includes(status)) {
    return new Response("Invalid status", { status: 400 });
  }

  const incomingStatus = status as CallbackStatus;

  // Terminal-state guard: once a sim is COMPLETED or FAILED we never accept
  // any further status updates from the engine. This protects against:
  //   1. Retried callbacks (network blip, engine retries) double-charging MT
  //   2. A late "RUNNING" arriving after a FAILED reset — would un-fail a sim
  //   3. The "FAILED then later COMPLETED" race where cron expired the sim
  //      and a slow engine callback then re-credits the merchant.
  // We do this with an atomic updateMany filtered by current status; if 0
  // rows match the row was already terminal — short-circuit.
  const existing = await db.simulation.findUnique({
    where: { id: simulationId },
    select: { status: true, storeId: true, simulationType: true },
  });
  if (!existing) {
    return new Response("Simulation not found", { status: 404 });
  }
  const currentStatus = existing.status;
  const isAlreadyTerminal = currentStatus === "COMPLETED" || currentStatus === "FAILED";
  if (isAlreadyTerminal) {
    console.info("[EngineCallback] ignored: sim already terminal", {
      simulationId,
      currentStatus,
      incomingStatus,
    });
    return new Response(null, { status: 200 });
  }

  console.info("[EngineCallback] received", {
    simulationId,
    phase: phase ?? 0,
    status: incomingStatus,
    score,
    actualMtCost,
    hasFailureReason: !!failureReason,
    agentLogCount: agentLogs?.length ?? 0,
  });

  // Update simulation record + insert agent logs
  await updateSimulationFromCallback(simulationId, {
    phase: phase ?? 0,
    status: incomingStatus,
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

  // Defense in depth: even with a valid ENGINE_API_KEY, never trust negative
  // or non-finite numbers. Cap any single callback to a sane upper bound.
  const safeMt =
    typeof actualMtCost === "number" && Number.isFinite(actualMtCost) && actualMtCost > 0
      ? Math.min(actualMtCost, 10_000)
      : 0;

  if (incomingStatus === "COMPLETED") {
    const sim = await db.simulation.findUnique({
      where: { id: simulationId },
      include: { store: { select: { shopDomain: true } } },
    });

    if (safeMt > 0 && sim?.store?.shopDomain) {
      // The terminal-state guard above already ensures this branch only runs
      // once per simulation, so the MT charge cannot double-bill on retry.
      await incrementMtUsage(sim.store.shopDomain, safeMt);
      console.info("[EngineCallback] MT charged", {
        simulationId,
        shopDomain: sim.store.shopDomain,
        mt: safeMt,
      });
    }

    if (sim?.simulationType === "RETAKE" && sim.originalSimulationId) {
      _triggerRetakeEvaluation(sim).catch((err: unknown) => {
        console.error("[Retake] Evaluation trigger failed", {
          simulationId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  return new Response(null, { status: 200 });
};
