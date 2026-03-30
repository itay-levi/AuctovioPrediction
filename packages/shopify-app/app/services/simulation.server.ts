import db from "../db.server";
import { AGENT_COUNTS, SIM_LIMITS, getMtBudgetStatus } from "./store.server";
import { triggerSimulation } from "./engine.server";
import type { SimulationStatus, PlanTier } from "@prisma/client";

const MT_ESTIMATE_PER_AGENT = 2; // ~2 MT per agent for a full simulation

export async function estimateSimulationCost(tier: PlanTier): Promise<number> {
  return AGENT_COUNTS[tier] * MT_ESTIMATE_PER_AGENT;
}

export async function canRunSimulation(
  shopDomain: string,
  storeId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Skip all budget/limit checks in development
  if (process.env.NODE_ENV === "development") {
    return { allowed: true };
  }

  const budget = await getMtBudgetStatus(shopDomain);
  if (!budget) return { allowed: false, reason: "Store not found" };

  const estimate = await estimateSimulationCost(budget.tier);
  if (budget.remaining < estimate) {
    return {
      allowed: false,
      reason: `Insufficient MT budget. Need ${estimate} MT, have ${budget.remaining}.`,
    };
  }

  // Check monthly simulation count
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const simCount = await db.simulation.count({
    where: {
      storeId,
      createdAt: { gte: monthStart },
      status: { not: "FAILED" as SimulationStatus },
    },
  });

  const limit = SIM_LIMITS[budget.tier];
  if (simCount >= limit) {
    return {
      allowed: false,
      reason: `Monthly simulation limit reached (${limit} for ${budget.tier} plan).`,
    };
  }

  return { allowed: true };
}

export async function createSimulation(
  storeId: string,
  shopDomain: string,
  shopType: string,
  productUrl: string,
  productJson: unknown,
  tier: PlanTier,
  appUrl: string,
  focusAreas: string[] = []
) {
  // DEV_AGENT_COUNT lets you tune locally without changing tier logic.
  // e.g. DEV_AGENT_COUNT=10 in .env gives better signal than 5 but runs faster than 25.
  const devCount = process.env.NODE_ENV === "development" && process.env.DEV_AGENT_COUNT
    ? parseInt(process.env.DEV_AGENT_COUNT, 10)
    : null;
  const agentCount = devCount ?? AGENT_COUNTS[tier];
  const estimatedMt = agentCount * MT_ESTIMATE_PER_AGENT;

  // Create DB record
  const simulation = await db.simulation.create({
    data: {
      storeId,
      productUrl,
      productJson: productJson as object,
      status: "PENDING",
      phase: 0,
      mtCost: estimatedMt,
      focusAreas: focusAreas.length ? focusAreas : undefined,
    },
  });

  // Trigger engine async (fire and forget — results come via callback)
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  triggerSimulation({
    simulationId: simulation.id,
    shopDomain,
    shopType: shopType || "general_retail",
    productUrl,
    productJson,
    agentCount,
    callbackUrl,
    focusAreas,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Engine] ❌ Simulation ${simulation.id} failed to trigger: ${msg}`);
    db.simulation
      .update({
        where: { id: simulation.id },
        data: { status: "FAILED" },
      })
      .catch(() => {});
  });

  return simulation;
}

export async function getSimulation(id: string) {
  return db.simulation.findUnique({
    where: { id },
    include: {
      agentLogs: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

export async function getPreviousCompletedSimulation(
  storeId: string,
  productUrl: string,
  beforeDate: Date,
  excludeId: string
) {
  return db.simulation.findFirst({
    where: {
      storeId,
      productUrl,
      status: "COMPLETED",
      createdAt: { lt: beforeDate },
      id: { not: excludeId },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      score: true,
      trustAudit: true,
      createdAt: true,
    },
  });
}

export async function getRecentSimulations(storeId: string, limit = 10) {
  return db.simulation.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      productUrl: true,
      productJson: true,
      status: true,
      phase: true,
      score: true,
      imageScore: true,
      createdAt: true,
    },
  });
}

export async function updateSimulationFromCallback(
  simulationId: string,
  data: {
    phase: number;
    status: SimulationStatus;
    score?: number;
    imageScore?: number;
    reportJson?: unknown;
    recommendations?: unknown[];
    trustAudit?: unknown;
    comparisonInsight?: string;
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
) {
  await db.$transaction(async (tx) => {
    await tx.simulation.update({
      where: { id: simulationId },
      data: {
        phase: data.phase,
        status: data.status,
        score: data.score,
        imageScore: data.imageScore,
        reportJson: data.reportJson as object | undefined,
        recommendations: data.recommendations as object[] | undefined,
        trustAudit: data.trustAudit as object | undefined,
        comparisonInsight: data.comparisonInsight,
      },
    });

    if (data.agentLogs?.length) {
      await tx.agentLog.createMany({
        data: data.agentLogs.map((log) => ({
          simulationId,
          agentId: log.agentId,
          archetype: log.archetype,
          archetypeName: log.archetypeName ?? null,
          archetypeEmoji: log.archetypeEmoji ?? null,
          personaName: log.personaName ?? null,
          personaAge: log.personaAge ?? null,
          personaOccupation: log.personaOccupation ?? null,
          personaMotivation: log.personaMotivation ?? null,
          nicheConcern: log.nicheConcern ?? null,
          phase: log.phase,
          verdict: log.verdict,
          reasoning: log.reasoning,
        })),
        skipDuplicates: true,
      });
    }
  });
}
