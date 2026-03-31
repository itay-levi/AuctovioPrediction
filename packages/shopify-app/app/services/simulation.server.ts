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

function _triggerWithErrorHandling(
  simulationId: string,
  payload: Parameters<typeof triggerSimulation>[0],
) {
  triggerSimulation(payload).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Engine] ❌ Simulation ${simulationId} failed to trigger: ${msg}`);
    db.simulation
      .update({ where: { id: simulationId }, data: { status: "FAILED" } })
      .catch(() => {});
  });
}

export async function createSimulation(
  storeId: string,
  shopDomain: string,
  shopType: string,
  productUrl: string,
  productJson: unknown,
  tier: PlanTier,
  appUrl: string,
  focusAreas: string[] = [],
  labConfig?: import("./engine.server").LabConfig,
) {
  const devCount = process.env.NODE_ENV === "development" && process.env.DEV_AGENT_COUNT
    ? parseInt(process.env.DEV_AGENT_COUNT, 10)
    : null;
  const agentCount = devCount ?? AGENT_COUNTS[tier];
  const estimatedMt = agentCount * MT_ESTIMATE_PER_AGENT;
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  const shopTypeResolved = shopType || "general_retail";

  // ── Customer Lab: create two linked simulations (baseline + target) ─────────
  if (labConfig) {
    const labGroupId = `lab_${Date.now()}_${storeId.slice(-6)}`;

    // Baseline — general public, default settings, no labConfig
    const baseline = await db.simulation.create({
      data: {
        storeId,
        productUrl,
        productJson: productJson as object,
        status: "PENDING",
        phase: 0,
        mtCost: estimatedMt,
        focusAreas: focusAreas.length ? focusAreas : undefined,
        labGroupId,
        isBaseline: true,
      },
    });

    // Target — user's custom Lab config
    const target = await db.simulation.create({
      data: {
        storeId,
        productUrl,
        productJson: productJson as object,
        status: "PENDING",
        phase: 0,
        mtCost: estimatedMt,
        focusAreas: focusAreas.length ? focusAreas : undefined,
        labGroupId,
        isBaseline: false,
      },
    });

    // Trigger both in parallel (independent runs, comparison computed after both complete)
    const baselineLabConfig: import("./engine.server").LabConfig = {
      audience: "general",
      skepticism: 5,
      coreConcern: "",
      brutalityLevel: 5,
      preset: "",
    };

    _triggerWithErrorHandling(baseline.id, {
      simulationId: baseline.id,
      shopDomain,
      shopType: shopTypeResolved,
      productUrl,
      productJson,
      agentCount,
      callbackUrl,
      focusAreas,
      labConfig: baselineLabConfig,
      labGroupId,
      isBaseline: true,
    });

    _triggerWithErrorHandling(target.id, {
      simulationId: target.id,
      shopDomain,
      shopType: shopTypeResolved,
      productUrl,
      productJson,
      agentCount,
      callbackUrl,
      focusAreas,
      labConfig,
      labGroupId,
      isBaseline: false,
    });

    // Return the TARGET simulation — the results page is keyed to this ID,
    // and it will look up the partner baseline via labGroupId.
    return target;
  }

  // ── Standard single simulation ───────────────────────────────────────────────
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

  _triggerWithErrorHandling(simulation.id, {
    simulationId: simulation.id,
    shopDomain,
    shopType: shopTypeResolved,
    productUrl,
    productJson,
    agentCount,
    callbackUrl,
    focusAreas,
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

export async function getLabPartnerSimulation(labGroupId: string, excludeId: string) {
  return db.simulation.findFirst({
    where: {
      labGroupId,
      id: { not: excludeId },
    },
    select: {
      id: true,
      status: true,
      score: true,
      reportJson: true,
      isBaseline: true,
      comparisonSummary: true,
    },
  });
}

export async function saveComparisonSummary(simulationId: string, summary: object) {
  return db.simulation.update({
    where: { id: simulationId },
    data: { comparisonSummary: summary },
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
