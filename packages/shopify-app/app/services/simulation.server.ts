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
  appUrl: string
) {
  const agentCount = AGENT_COUNTS[tier];
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
  }).catch((err: unknown) => {
    console.error(`[Engine] Failed to trigger simulation ${simulation.id}:`, err);
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

export async function getRecentSimulations(storeId: string, limit = 10) {
  return db.simulation.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      productUrl: true,
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
    agentLogs?: {
      agentId: string;
      archetype: string;
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
      },
    });

    if (data.agentLogs?.length) {
      await tx.agentLog.createMany({
        data: data.agentLogs.map((log) => ({
          simulationId,
          agentId: log.agentId,
          archetype: log.archetype,
          phase: log.phase,
          verdict: log.verdict,
          reasoning: log.reasoning,
        })),
        skipDuplicates: true,
      });
    }
  });
}
