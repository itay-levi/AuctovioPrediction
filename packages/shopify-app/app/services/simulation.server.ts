import db from "../db.server";
import { AGENT_COUNTS, SIM_LIMITS, MT_LIMITS, getMtBudgetStatus } from "./store.server";
import { triggerSimulation, triggerTeaserSimulation } from "./engine.server";
import type { SimulationStatus, PlanTier } from "@prisma/client";

const MT_ESTIMATE_PER_AGENT = 2; // ~2 MT per agent for a full simulation
// Cost we reserve up front for a FREE-tier teaser run. Matches the engine's
// fixed ~1 MT cost so quota math stays honest.
const TEASER_MT_COST = 1;

/**
 * Thrown by createSimulation/createRetakeSimulation when the in-transaction
 * quota recheck fails (e.g. two concurrent submits both passed canRunSimulation
 * but only one actually fits). Routes catch this and surface a friendly message.
 */
export class QuotaExceededError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "QuotaExceededError";
  }
}

/**
 * Whether the full Customer Confidence Report for this simulation is visible
 * to the merchant. Free-tier sees a teaser by default; PRO/ENTERPRISE always
 * see everything; FREE tier merchants who paid the $4.99 one-time unlock for
 * THIS specific simulation see everything for that one report.
 */
export function isReportUnlocked(
  sim: { unlockedAt?: Date | string | null } | null | undefined,
  tier: PlanTier,
): boolean {
  if (process.env.NODE_ENV === "development") return true;
  if (tier === "PRO" || tier === "ENTERPRISE") return true;
  return !!sim?.unlockedAt;
}

function _monthStart(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function estimateSimulationCost(tier: PlanTier): Promise<number> {
  return AGENT_COUNTS[tier] * MT_ESTIMATE_PER_AGENT;
}

export async function canRunSimulation(
  shopDomain: string,
  storeId: string,
  // simulationsToCreate: how many DB rows the caller will create. Lab=2,
  // batch What-If=N, single sim=1.
  simulationsToCreate: number = 1,
  // countsTowardSlotQuota: only true for root sims (the primary monthly limit).
  // What-If / delta / Retake sims consume MT but not the analysis slot quota.
  countsTowardSlotQuota: boolean = true,
): Promise<{ allowed: boolean; reason?: string }> {
  // Skip all budget/limit checks in development
  if (process.env.NODE_ENV === "development") {
    return { allowed: true };
  }

  const budget = await getMtBudgetStatus(shopDomain);
  if (!budget) return { allowed: false, reason: "Store not found" };

  // Expire zombies first so they don't inflate the monthly count
  await expireStuckSimulations(storeId);

  const perRunEstimate = await estimateSimulationCost(budget.tier);
  const totalEstimate = perRunEstimate * simulationsToCreate;
  if (budget.remaining < totalEstimate) {
    return {
      allowed: false,
      reason: `Insufficient MT budget. Need ${totalEstimate} MT, have ${budget.remaining}.`,
    };
  }

  if (countsTowardSlotQuota) {
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
    if (simCount + simulationsToCreate > limit) {
      return {
        allowed: false,
        reason: `Monthly simulation limit reached (${limit} for ${budget.tier} plan).`,
      };
    }
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
      .catch((updateErr: unknown) => {
        // Last line of defense before the cron sweep — at least log it so
        // ops can see DB outages causing stuck PENDING rows.
        console.error("[Engine] Failed to mark sim FAILED after trigger error", {
          simulationId,
          err: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      });
  });
}

/**
 * Atomically: recount this-month root simulations, recompute used MT, and
 * insert the new simulation rows in a single transaction. If concurrent
 * submits at the quota boundary cause a violation, this throws
 * QuotaExceededError so the route can surface a friendly message.
 */
async function _atomicCreateSimulations<T>(args: {
  storeId: string;
  tier: PlanTier;
  rootSimsToCreate: number; // 0 for delta/retake, 1 for single, 2 for Lab
  totalMtToReserve: number;
  insert: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>;
}): Promise<T> {
  const { storeId, tier, rootSimsToCreate, totalMtToReserve, insert } = args;
  return db.$transaction(async (tx) => {
    if (rootSimsToCreate > 0) {
      const monthStart = _monthStart();
      const slotCount = await tx.simulation.count({
        where: {
          storeId,
          originalSimulationId: null,
          createdAt: { gte: monthStart },
          status: { not: "FAILED" as SimulationStatus },
        },
      });
      const slotLimit = SIM_LIMITS[tier];
      if (slotCount + rootSimsToCreate > slotLimit) {
        throw new QuotaExceededError(
          `Monthly simulation limit reached (${slotLimit} for ${tier} plan).`,
        );
      }
    }

    if (totalMtToReserve > 0) {
      const monthStart = _monthStart();
      const mtAgg = await tx.simulation.aggregate({
        where: {
          storeId,
          status: "COMPLETED",
          createdAt: { gte: monthStart },
        },
        _sum: { mtCost: true },
      });
      const used = mtAgg._sum.mtCost ?? 0;
      const limit = MT_LIMITS[tier];
      if (used + totalMtToReserve > limit) {
        throw new QuotaExceededError(
          `Insufficient MT budget. Need ${totalMtToReserve} MT, have ${Math.max(0, limit - used)}.`,
        );
      }
    }

    return insert(tx);
  }, {
    // Serializable: catches the case where two concurrent transactions both
    // see the same count and both try to insert past the limit.
    isolationLevel: "Serializable",
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

    // Atomic: recheck quota + insert both rows in one Serializable transaction
    // so two concurrent Lab submits at the boundary cannot both succeed.
    const { baseline, target } = await _atomicCreateSimulations({
      storeId,
      tier,
      rootSimsToCreate: 2,
      totalMtToReserve: estimatedMt * 2,
      insert: async (tx) => {
        const baselineRow = await tx.simulation.create({
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
        const targetRow = await tx.simulation.create({
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
        return { baseline: baselineRow, target: targetRow };
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
  // For FREE-tier merchants we run the cheap fast teaser (~1 MT, ~30s) so
  // engine spend stays aligned with revenue. The full multi-phase debate only
  // fires after the merchant pays $4.99 to unlock — see unlockAndTriggerFullAnalysis
  // and webhooks.engine.callback.tsx for the rest of the flow.
  const isTeaserOnly = !isPro;
  const reservedMt = isTeaserOnly ? TEASER_MT_COST : estimatedMt;

  const simulation = await _atomicCreateSimulations({
    storeId,
    tier,
    rootSimsToCreate: 1,
    totalMtToReserve: reservedMt,
    insert: (tx) => {
      // Build data object separately so the Prisma type checker can validate
      // the base shape cleanly; cast only the optional unlock-flow fields
      // (fullAnalysisStartedAt is added via prisma migrate after deploy).
      const data = {
        storeId,
        productUrl,
        productJson: productJson as object,
        status: "PENDING" as SimulationStatus,
        phase: 0,
        mtCost: reservedMt,
        focusAreas: focusAreas.length ? focusAreas : undefined,
      };
      // Paid tiers skip the teaser — mark the full run as started up front
      // so the gating helpers can tell the two paths apart immediately.
      const dataWithFullFlag = isPro
        ? { ...data, fullAnalysisStartedAt: new Date() }
        : data;
      return tx.simulation.create({
        data: dataWithFullFlag as Parameters<typeof tx.simulation.create>[0]["data"],
      });
    },
  });
  console.info("[Sim] created", {
    simulationId: simulation.id,
    shopDomain,
    tier,
    mode: isTeaserOnly ? "teaser" : "full",
    agentCount: isTeaserOnly ? 1 : agentCount,
    isLab: false,
  });

  if (isTeaserOnly) {
    _triggerTeaserWithErrorHandling(simulation.id, {
      simulationId: simulation.id,
      shopDomain,
      shopType: shopTypeResolved,
      productUrl,
      productJson,
      callbackUrl,
    });
  } else {
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
  }

  return simulation;
}

/** Mirror of _triggerWithErrorHandling but for the fast teaser endpoint. */
function _triggerTeaserWithErrorHandling(
  simulationId: string,
  payload: Parameters<typeof triggerTeaserSimulation>[0],
) {
  triggerTeaserSimulation(payload).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Engine] ❌ Teaser ${simulationId} failed to trigger: ${msg}`);
    db.simulation
      .update({
        where: { id: simulationId },
        data: {
          status: "FAILED",
          failureReason: "The quick preview could not be started. Please try again.",
        } as Parameters<typeof db.simulation.update>[0]["data"],
      })
      .catch((updateErr: unknown) => {
        console.error("[Engine] Failed to mark teaser FAILED after trigger error", {
          simulationId,
          err: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      });
  });
}

/**
 * Called by the unlock callback once Shopify confirms the $4.99 charge is
 * ACTIVE. Marks the simulation unlocked, resets its status so the engine
 * webhook callback won't be rejected as terminal, and fires the deep
 * multi-phase panel run. The merchant sees the LivePanelRoom while the
 * full analysis runs; the result lands via the standard webhook.
 */
export async function unlockAndTriggerFullAnalysis(args: {
  simulationId: string;
  chargeId: string;
  shopDomain: string;
  shopType: string | null;
  tier: PlanTier;
  appUrl: string;
}): Promise<void> {
  const { simulationId, chargeId, shopDomain, shopType, tier, appUrl } = args;

  const sim = await db.simulation.findUnique({
    where: { id: simulationId },
    select: {
      id: true, productUrl: true, productJson: true, focusAreas: true,
    },
  });
  if (!sim) {
    throw new Error(`unlockAndTriggerFullAnalysis: sim ${simulationId} not found`);
  }

  const devCount = process.env.NODE_ENV === "development" && process.env.DEV_AGENT_COUNT
    ? parseInt(process.env.DEV_AGENT_COUNT, 10)
    : null;
  const agentCount = devCount ?? AGENT_COUNTS[tier];
  const estimatedMt = agentCount * MT_ESTIMATE_PER_AGENT;
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;

  // Atomically flip unlock fields + reset run state. Status must move OUT of
  // terminal (COMPLETED) so the engine webhook callback's terminal-state
  // guard accepts the next batch of phase updates.
  await db.simulation.update({
    where: { id: simulationId },
    data: {
      unlockedAt: new Date(),
      unlockChargeId: chargeId,
      fullAnalysisStartedAt: new Date(),
      status: "PENDING",
      phase: 0,
      mtCost: estimatedMt,
      // Wipe teaser-only artefacts so the UI doesn't briefly show stale data.
      score: null,
      reportJson: undefined as unknown as object,
    } as Parameters<typeof db.simulation.update>[0]["data"],
  });

  console.info("[Unlock] full analysis triggered", { simulationId, shopDomain, tier });

  _triggerWithErrorHandling(simulationId, {
    simulationId,
    shopDomain,
    shopType: shopType || "general_retail",
    productUrl: sim.productUrl,
    productJson: sim.productJson,
    agentCount,
    callbackUrl,
    focusAreas: (sim.focusAreas as string[] | null) ?? [],
    isPro: tier === "PRO" || tier === "ENTERPRISE" || true, // unlocked = treat as paid
  });
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

  const retakeSim = await _atomicCreateSimulations({
    storeId: originalSim.storeId,
    tier,
    rootSimsToCreate: 0, // Retakes don't consume monthly slot quota
    totalMtToReserve: estimatedMt,
    insert: (tx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx as any).simulation.create({
        data: {
          storeId: originalSim.storeId,
          productUrl: originalSim.productUrl,
          productJson: freshProductJson as object,
          status: "PENDING",
          phase: 0,
          mtCost: estimatedMt,
          originalSimulationId: originalSim.id,
          simulationType: "RETAKE",
        },
      }) as Promise<{ id: string; storeId: string; productUrl: string; status: SimulationStatus }>,
  });
  console.info("[Sim] retake created", { simulationId: retakeSim.id, shopDomain, originalSimulationId: originalSim.id, tier });

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
      confidenceScore?: number;
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
