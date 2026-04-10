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

  // Expire zombies first so they don't inflate the monthly count
  await expireStuckSimulations(storeId);

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

  // Only count root (product scan) simulations — What-Ifs / delta runs are not
  // new analyses and should not consume the monthly slot quota.
  const simCount = await db.simulation.count({
    where: {
      storeId,
      originalSimulationId: null,
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

/** Monthly product-analysis slots (root simulations only — same rules as {@link canRunSimulation}). */
export async function getMonthlyAnalysesQuota(
  storeId: string,
  tier: PlanTier,
): Promise<{ used: number; limit: number; remaining: number }> {
  await expireStuckSimulations(storeId);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const used = await db.simulation.count({
    where: {
      storeId,
      originalSimulationId: null,
      createdAt: { gte: monthStart },
      status: { not: "FAILED" as SimulationStatus },
    },
  });

  const limit = SIM_LIMITS[tier];
  return { used, limit, remaining: Math.max(0, limit - used) };
}

function _triggerWithErrorHandling(
  simulationId: string,
  payload: Parameters<typeof triggerSimulation>[0],
) {
  triggerSimulation(payload).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Engine] ❌ Simulation ${simulationId} failed to trigger: ${msg}`);
    db.simulation
      .update({
        where: { id: simulationId },
        data: {
          status: "FAILED",
          failureReason: "The analysis could not be started. Please try again.",
        } as Parameters<typeof db.simulation.update>[0]["data"],
      })
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
  storeContext?: import("./engine.server").StoreContext,
) {
  const devCount = process.env.NODE_ENV === "development" && process.env.DEV_AGENT_COUNT
    ? parseInt(process.env.DEV_AGENT_COUNT, 10)
    : null;
  const agentCount = devCount ?? AGENT_COUNTS[tier];
  const estimatedMt = agentCount * MT_ESTIMATE_PER_AGENT;
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  const shopTypeResolved = shopType || "general_retail";
  const isPro = tier === "PRO" || tier === "ENTERPRISE";

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
      isPro,
      storeContext,
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
      isPro,
      storeContext,
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
    isPro,
    storeContext,
  });

  return simulation;
}

/**
 * Create and fire a Retake Test simulation.
 * A retake re-runs the full panel on the merchant's CURRENT (updated) live listing.
 * It is linked to the original simulation and costs MT budget like a full scan,
 * but does NOT count against the monthly simulation slot quota.
 */
export async function createRetakeSimulation(
  originalSim: { id: string; storeId: string; productUrl: string; productDna?: unknown; score?: number | null },
  freshProductJson: unknown,
  shopDomain: string,
  shopType: string,
  tier: PlanTier,
  appUrl: string,
  labConfig?: import("./engine.server").LabConfig,
  storeContext?: import("./engine.server").StoreContext,
) {
  const agentCount = AGENT_COUNTS[tier];
  const estimatedMt = agentCount * MT_ESTIMATE_PER_AGENT;
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  const isPro = tier === "PRO" || tier === "ENTERPRISE";

  const retakeSim = await db.simulation.create({
    data: {
      storeId: originalSim.storeId,
      productUrl: originalSim.productUrl,
      productJson: freshProductJson as object,
      status: "PENDING",
      phase: 0,
      mtCost: estimatedMt,
      originalSimulationId: originalSim.id,
      simulationType: "RETAKE",
    } as Parameters<typeof db.simulation.create>[0]["data"],
  });

  _triggerWithErrorHandling(retakeSim.id, {
    simulationId: retakeSim.id,
    shopDomain,
    shopType: shopType || "general_retail",
    productUrl: originalSim.productUrl,
    productJson: freshProductJson,
    agentCount,
    callbackUrl,
    isPro,
    labConfig,
    storeContext,
  });

  return retakeSim;
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

/** Walk `originalSimulationId` chain so lab actions always target the product root scan. */
export async function getSimulationLabRoot(id: string) {
  let current = await getSimulation(id);
  if (!current) return null;
  const seen = new Set<string>([current.id]);
  while (current.originalSimulationId) {
    const parentId = current.originalSimulationId;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await getSimulation(parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
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
      recommendations: true,
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
    where: { storeId, originalSimulationId: null },
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
        ...(data.productDna !== undefined && { productDna: data.productDna as object }),
        ...(data.failureReason !== undefined && { failureReason: data.failureReason }),
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
          confidenceScore: log.confidenceScore ?? null,
          reasoning: log.reasoning,
        })),
        skipDuplicates: true,
      });
    }
  });
}

/**
 * Mark any PENDING or RUNNING simulation older than `timeoutMinutes` as FAILED.
 * Call this on page load (history, results) and at engine startup so zombie
 * simulations never stay stuck forever after a crash or restart.
 *
 * Returns the number of simulations that were expired.
 */
export async function expireStuckSimulations(
  storeId: string,
  timeoutMinutes = 20
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  const result = await db.simulation.updateMany({
    where: {
      storeId,
      status: { in: ["PENDING", "RUNNING"] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      failureReason:
        "The analysis did not complete — the server may have restarted mid-run. Your budget has not been charged. Please run a new analysis.",
    },
  });
  return result.count;
}
