import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStoreFindMany = vi.fn();
const mockSimulationFindMany = vi.fn();
const mockSessionFindFirst = vi.fn();
const mockStoreUpdate = vi.fn();

vi.mock("../db.server", () => ({
  default: {
    store: {
      findMany: mockStoreFindMany,
      update: mockStoreUpdate,
    },
    simulation: { findMany: mockSimulationFindMany },
    session: { findFirst: mockSessionFindFirst },
  },
}));

vi.mock("../services/health-score.server", () => ({
  computeShopHealthScore: vi.fn().mockResolvedValue({
    healthScore: 70,
    simulationCount: 3,
    topFriction: "price",
  }),
}));

vi.mock("../services/email.server", () => ({
  sendWeeklyDigest: vi.fn(),
}));

import { computeShopHealthScore } from "../services/health-score.server";
import { sendWeeklyDigest } from "../services/email.server";
import { action } from "./api.weekly-scan";

describe("api.weekly-scan", () => {
  beforeEach(() => {
    mockStoreFindMany.mockReset();
    mockSimulationFindMany.mockReset();
    mockSessionFindFirst.mockReset();
    mockStoreUpdate.mockReset();
    vi.mocked(sendWeeklyDigest).mockReset();
  });

  it("401 with wrong bearer", async () => {
    const res = await action({
      request: new Request("https://x", { headers: { Authorization: "Bearer wrong" } }),
    } as never);
    expect(res.status).toBe(401);
  });

  it("processes enterprise stores", async () => {
    mockStoreFindMany.mockResolvedValue([
      { id: "s1", shopDomain: "a.myshopify.com", accessToken: "t" },
    ]);
    mockSimulationFindMany.mockResolvedValue([
      { productUrl: "https://x/p/soap", score: 88 },
    ]);
    mockSessionFindFirst.mockResolvedValue({ email: "m@example.com" });
    mockStoreUpdate.mockResolvedValue({});
    const res = await action({
      request: new Request("https://x", { headers: { Authorization: "Bearer test-cron-secret" } }),
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(sendWeeklyDigest).toHaveBeenCalled();
  });

  it("records errors per shop", async () => {
    mockStoreFindMany.mockResolvedValue([{ id: "s1", shopDomain: "a.myshopify.com", accessToken: "t" }]);
    vi.mocked(computeShopHealthScore).mockRejectedValueOnce(new Error("db"));
    const res = await action({
      request: new Request("https://x", { headers: { Authorization: "Bearer test-cron-secret" } }),
    } as never);
    const body = await res.json();
    expect(body.results[0].status).toMatch(/error/);
  });
});
