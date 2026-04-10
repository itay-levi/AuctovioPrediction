import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeShopHealthScore } from "./health-score.server";

vi.mock("../db.server", () => ({
  default: {
    simulation: { findMany: vi.fn() },
  },
}));

import db from "../db.server";

describe("computeShopHealthScore", () => {
  beforeEach(() => {
    vi.mocked(db.simulation.findMany).mockReset();
  });

  it("returns zeros when no simulations", async () => {
    vi.mocked(db.simulation.findMany).mockResolvedValue([]);
    await expect(computeShopHealthScore("store-1")).resolves.toEqual({
      healthScore: 0,
      simulationCount: 0,
      topFriction: null,
    });
  });

  it("averages scores and picks top friction key", async () => {
    vi.mocked(db.simulation.findMany).mockResolvedValue([
      {
        score: 80,
        reportJson: {
          friction: {
            price: { dropoutPct: 10 },
            trust: { dropoutPct: 50 },
            logistics: { dropoutPct: 5 },
          },
        },
      },
      {
        score: 60,
        reportJson: {
          friction: {
            trust: { dropoutPct: 40 },
          },
        },
      },
    ] as Awaited<ReturnType<typeof db.simulation.findMany>>);
    const r = await computeShopHealthScore("store-1");
    expect(r.healthScore).toBe(70);
    expect(r.simulationCount).toBe(2);
    expect(r.topFriction).toBe("trust");
  });

  it("ignores sims without friction", async () => {
    vi.mocked(db.simulation.findMany).mockResolvedValue([
      { score: 50, reportJson: null },
    ] as Awaited<ReturnType<typeof db.simulation.findMany>>);
    const r = await computeShopHealthScore("store-1");
    expect(r.topFriction).toBe(null);
  });
});
