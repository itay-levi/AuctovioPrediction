import db from "../db.server";

export interface HealthScoreResult {
  healthScore: number;
  simulationCount: number;
  topFriction: string | null;
}

export async function computeShopHealthScore(storeId: string): Promise<HealthScoreResult> {
  const sims = await db.simulation.findMany({
    where: { storeId, status: "COMPLETED", score: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { score: true, reportJson: true },
  });

  if (sims.length === 0) {
    return { healthScore: 0, simulationCount: 0, topFriction: null };
  }

  const scores = sims.map((s) => s.score!);
  const healthScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  // Find most common friction category
  const frictionCounts: Record<string, number> = { price: 0, trust: 0, logistics: 0 };
  for (const sim of sims) {
    const report = sim.reportJson as { friction?: Record<string, { dropoutPct?: number }> } | null;
    if (!report?.friction) continue;
    let maxPct = 0;
    let maxKey = "";
    for (const [key, val] of Object.entries(report.friction)) {
      if ((val?.dropoutPct ?? 0) > maxPct) {
        maxPct = val?.dropoutPct ?? 0;
        maxKey = key;
      }
    }
    if (maxKey) frictionCounts[maxKey] = (frictionCounts[maxKey] ?? 0) + 1;
  }

  const topFriction = Object.entries(frictionCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;

  return { healthScore, simulationCount: sims.length, topFriction };
}
