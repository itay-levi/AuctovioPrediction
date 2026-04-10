import { describe, expect, it, vi } from "vitest";
import {
  AGENT_COUNTS,
  MT_LIMITS,
  SIM_LIMITS,
  getMtBudgetStatus,
  getPlanTier,
  incrementMtUsage,
  setShopType,
  upsertStore,
} from "./store.server";

vi.mock("../db.server", () => ({
  default: {
    store: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import db from "../db.server";

describe("store.server", () => {
  it("exports tier limits", () => {
    expect(MT_LIMITS.FREE).toBe(30);
    expect(SIM_LIMITS.PRO).toBe(10);
    expect(AGENT_COUNTS.ENTERPRISE).toBe(50);
  });

  it("upsertStore delegates to prisma", async () => {
    vi.mocked(db.store.upsert).mockResolvedValue({ id: "1" } as never);
    await upsertStore("s.myshopify.com", "tok");
    expect(db.store.upsert).toHaveBeenCalledWith({
      where: { shopDomain: "s.myshopify.com" },
      create: { shopDomain: "s.myshopify.com", accessToken: "tok" },
      update: { accessToken: "tok" },
    });
  });

  it("getPlanTier returns FREE when missing", async () => {
    vi.mocked(db.store.findUnique).mockResolvedValue(null);
    await expect(getPlanTier("x")).resolves.toBe("FREE");
  });

  it("getMtBudgetStatus returns null without store", async () => {
    vi.mocked(db.store.findUnique).mockResolvedValue(null);
    await expect(getMtBudgetStatus("x")).resolves.toBeNull();
  });

  it("getMtBudgetStatus computes remaining", async () => {
    vi.mocked(db.store.findUnique).mockResolvedValue({
      planTier: "FREE",
      mtBudgetUsed: 10,
    } as never);
    await expect(getMtBudgetStatus("x")).resolves.toEqual({
      used: 10,
      limit: 30,
      remaining: 20,
      tier: "FREE",
    });
  });

  it("setShopType and incrementMtUsage call update", async () => {
    vi.mocked(db.store.update).mockResolvedValue({} as never);
    await setShopType("s", "niche");
    expect(db.store.update).toHaveBeenCalledWith({
      where: { shopDomain: "s" },
      data: { shopType: "niche" },
    });
    await incrementMtUsage("s", 3);
    expect(db.store.update).toHaveBeenCalledWith({
      where: { shopDomain: "s" },
      data: { mtBudgetUsed: { increment: 3 } },
    });
  });
});
