import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSimCount, mockUpdateMany, mockStoreFindUnique, mockSimAggregate } = vi.hoisted(() => ({
  mockSimCount: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockStoreFindUnique: vi.fn(),
  mockSimAggregate: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: {
    simulation: {
      count: mockSimCount,
      updateMany: mockUpdateMany,
      aggregate: mockSimAggregate,
    },
    store: {
      findUnique: mockStoreFindUnique,
    },
  },
}));

vi.mock("./engine.server", () => ({
  triggerSimulation: vi.fn(),
}));

import {
  canRunSimulation,
  estimateSimulationCost,
  expireStuckSimulations,
  getMonthlyAnalysesQuota,
} from "./simulation.server";

describe("simulation.server", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    mockSimCount.mockReset();
    mockUpdateMany.mockReset();
    mockStoreFindUnique.mockReset();
    mockSimAggregate.mockReset();
    mockUpdateMany.mockResolvedValue({ count: 0 });
    // Default: 0 MT used this month
    mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 0 } });
  });

  describe("estimateSimulationCost", () => {
    it("FREE = 5 agents * 2 MT = 10", async () => {
      expect(await estimateSimulationCost("FREE")).toBe(10);
    });
    it("PRO = 25 agents * 2 MT = 50", async () => {
      expect(await estimateSimulationCost("PRO")).toBe(50);
    });
    it("ENTERPRISE = 50 agents * 2 MT = 100", async () => {
      expect(await estimateSimulationCost("ENTERPRISE")).toBe(100);
    });
  });

  describe("canRunSimulation", () => {
    it("dev mode bypasses all checks", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(true);
    });

    it("rejects if store missing", async () => {
      mockStoreFindUnique.mockResolvedValue(null);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Store not found/);
    });

    it("rejects when MT remaining < 1 sim cost", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 25 } }); // 30-25=5, need 10
      mockSimCount.mockResolvedValue(0);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Insufficient MT/);
    });

    it("rejects Lab quota (2 sims) when MT only covers 1", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 15 } }); // remaining 15, need 20
      mockSimCount.mockResolvedValue(0);
      const r = await canRunSimulation("s.com", "store-1", 2);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Need 20 MT/);
    });

    it("rejects when monthly slot count + simsToCreate > limit", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 0 } });
      mockSimCount.mockResolvedValue(2);
      const r = await canRunSimulation("s.com", "store-1", 2);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Monthly simulation limit/);
    });

    it("allows single sim when at exactly the boundary", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 20 } }); // remaining 10
      mockSimCount.mockResolvedValue(2);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(true);
    });

    it("rejects when at 3rd sim of FREE limit", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 0 } });
      mockSimCount.mockResolvedValue(3);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Monthly simulation limit/);
    });

    it("PRO plan allows 25-agent sims under MT budget", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "PRO" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 50 } }); // 500-50=450
      mockSimCount.mockResolvedValue(0);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(true);
    });

    it("delta sims (4th param=false) skip slot quota check", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 0 } });
      mockSimCount.mockResolvedValue(3);
      const r = await canRunSimulation("s.com", "store-1", 1, false);
      expect(r.allowed).toBe(true);
    });

    it("delta sim batch validates total MT cost", async () => {
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "PRO" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 380 } }); // 500-380=120
      const r = await canRunSimulation("s.com", "store-1", 3, false);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Need 150 MT/);
    });

    it("MT budget resets implicitly each month (sum is COMPLETED only)", async () => {
      // Simulating 'last month exhausted MT' — agg returns 0 since query filters to monthStart
      mockStoreFindUnique.mockResolvedValue({ id: "s1", planTier: "FREE" });
      mockSimAggregate.mockResolvedValue({ _sum: { mtCost: 0 } });
      mockSimCount.mockResolvedValue(0);
      const r = await canRunSimulation("s.com", "store-1");
      expect(r.allowed).toBe(true);
    });
  });

  describe("getMonthlyAnalysesQuota", () => {
    it("returns used/limit/remaining", async () => {
      mockSimCount.mockResolvedValue(2);
      const q = await getMonthlyAnalysesQuota("store-1", "PRO");
      expect(q).toEqual({ used: 2, limit: 10, remaining: 8 });
    });

    it("never returns negative remaining", async () => {
      mockSimCount.mockResolvedValue(15); // exceeded somehow
      const q = await getMonthlyAnalysesQuota("store-1", "PRO");
      expect(q.remaining).toBe(0);
    });
  });

  describe("expireStuckSimulations", () => {
    it("returns count of expired", async () => {
      mockUpdateMany.mockResolvedValue({ count: 4 });
      const n = await expireStuckSimulations("store-1");
      expect(n).toBe(4);
    });

    it("returns 0 when none stuck", async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      const n = await expireStuckSimulations("store-1");
      expect(n).toBe(0);
    });
  });
});
