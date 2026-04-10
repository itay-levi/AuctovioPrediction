import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelSubscription, createSubscription, PLANS, upgradePlanTier } from "./billing.server";

vi.mock("../db.server", () => ({
  default: { store: { update: vi.fn() } },
}));

import db from "../db.server";

describe("billing.server", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports plans", () => {
    expect(PLANS.PRO.price).toBe("29.90");
  });

  it("createSubscription passes test:true outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: {
            appSubscriptionCreate: {
              userErrors: [],
              confirmationUrl: "https://confirm",
            },
          },
        }),
      }),
    };
    await createSubscription(admin as never, "PRO", "https://return");
    const vars = admin.graphql.mock.calls[0][1] as { variables: { test: boolean } };
    expect(vars.variables.test).toBe(true);
  });

  it("createSubscription returns confirmationUrl", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: {
            appSubscriptionCreate: {
              userErrors: [],
              confirmationUrl: "https://confirm",
            },
          },
        }),
      }),
    };
    const url = await createSubscription(admin as never, "PRO", "https://return");
    expect(url).toBe("https://confirm");
    expect(admin.graphql).toHaveBeenCalled();
  });

  it("createSubscription throws on userErrors", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: {
            appSubscriptionCreate: {
              userErrors: [{ field: "x", message: "bad" }],
              confirmationUrl: "",
            },
          },
        }),
      }),
    };
    await expect(createSubscription(admin as never, "ENTERPRISE", "https://r")).rejects.toThrow(/bad/);
  });

  it("upgradePlanTier and cancelSubscription update store", async () => {
    vi.mocked(db.store.update).mockResolvedValue({} as never);
    await upgradePlanTier("s.myshopify.com", "PRO");
    expect(db.store.update).toHaveBeenCalledWith({
      where: { shopDomain: "s.myshopify.com" },
      data: { planTier: "PRO" },
    });
    await cancelSubscription("s.myshopify.com");
    expect(db.store.update).toHaveBeenCalledWith({
      where: { shopDomain: "s.myshopify.com" },
      data: { planTier: "FREE", mtBudgetUsed: 0 },
    });
  });
});
