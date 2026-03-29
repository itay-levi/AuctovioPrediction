import db from "../db.server";
import type { PlanTier } from "@prisma/client";

// Upsert store record on install / every auth
export async function upsertStore(shopDomain: string, accessToken: string) {
  return db.store.upsert({
    where: { shopDomain },
    create: { shopDomain, accessToken },
    update: { accessToken },
  });
}

export async function getStore(shopDomain: string) {
  return db.store.findUnique({ where: { shopDomain } });
}

export async function setShopType(shopDomain: string, shopType: string) {
  return db.store.update({ where: { shopDomain }, data: { shopType } });
}

export async function getPlanTier(shopDomain: string): Promise<PlanTier> {
  const store = await db.store.findUnique({
    where: { shopDomain },
    select: { planTier: true },
  });
  return store?.planTier ?? "FREE";
}

// MT budget limits per tier
export const MT_LIMITS: Record<PlanTier, number> = {
  FREE: 30,
  PRO: 500,
  ENTERPRISE: 2000,
};

// Simulation count limits per tier per month
export const SIM_LIMITS: Record<PlanTier, number> = {
  FREE: 3,
  PRO: 10,
  ENTERPRISE: 999,
};

// Agent counts per tier
export const AGENT_COUNTS: Record<PlanTier, number> = {
  FREE: 5,
  PRO: 25,
  ENTERPRISE: 50,
};

export async function getMtBudgetStatus(shopDomain: string) {
  const store = await db.store.findUnique({
    where: { shopDomain },
    select: { planTier: true, mtBudgetUsed: true },
  });
  if (!store) return null;
  const limit = MT_LIMITS[store.planTier];
  return {
    used: store.mtBudgetUsed,
    limit,
    remaining: Math.max(0, limit - store.mtBudgetUsed),
    tier: store.planTier,
  };
}

export async function incrementMtUsage(shopDomain: string, mt: number) {
  return db.store.update({
    where: { shopDomain },
    data: { mtBudgetUsed: { increment: mt } },
  });
}
