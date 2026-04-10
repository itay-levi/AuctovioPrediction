import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mockSessionDeleteMany: vi.fn(),
  mockStoreUpdateMany: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockCancelSubscription: vi.fn(),
  mockTransaction: vi.fn(),
  mockStoreFindUnique: vi.fn(),
  mockSimulationFindMany: vi.fn(),
  mockAgentLogDeleteMany: vi.fn(),
  mockSimulationDeleteMany: vi.fn(),
  mockCompetitorDeleteMany: vi.fn(),
  mockStoreDelete: vi.fn(),
  mockWebhook: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: {
    session: {
      deleteMany: mocks.mockSessionDeleteMany,
      update: mocks.mockSessionUpdate,
      findFirst: vi.fn(),
    },
    store: {
      updateMany: mocks.mockStoreUpdateMany,
      findUnique: mocks.mockStoreFindUnique,
      delete: mocks.mockStoreDelete,
    },
    $transaction: mocks.mockTransaction,
    simulation: {
      findMany: mocks.mockSimulationFindMany,
      deleteMany: mocks.mockSimulationDeleteMany,
    },
    agentLog: { deleteMany: mocks.mockAgentLogDeleteMany },
    competitorWatch: { deleteMany: mocks.mockCompetitorDeleteMany },
  },
}));

vi.mock("../services/billing.server", () => ({
  cancelSubscription: mocks.mockCancelSubscription,
}));

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: mocks.mockWebhook },
}));

describe("webhook actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        store: { findUnique: mocks.mockStoreFindUnique, delete: mocks.mockStoreDelete },
        simulation: {
          findMany: mocks.mockSimulationFindMany,
          deleteMany: mocks.mockSimulationDeleteMany,
        },
        agentLog: { deleteMany: mocks.mockAgentLogDeleteMany },
        competitorWatch: { deleteMany: mocks.mockCompetitorDeleteMany },
      });
    });
  });

  it("app.uninstalled purges sessions and blanks token", async () => {
    mocks.mockWebhook.mockResolvedValue({
      shop: "s.myshopify.com",
      session: { id: "sid" },
      topic: "APP_UNINSTALLED",
    });
    mocks.mockSessionDeleteMany.mockResolvedValue({});
    mocks.mockStoreUpdateMany.mockResolvedValue({});
    const { action } = await import("./webhooks.app.uninstalled");
    await action({ request: new Request("https://x") } as never);
    expect(mocks.mockSessionDeleteMany).toHaveBeenCalled();
    expect(mocks.mockStoreUpdateMany).toHaveBeenCalled();
  });

  it("scopes_update updates session scope", async () => {
    mocks.mockWebhook.mockResolvedValue({
      payload: { current: ["read_products"] },
      session: { id: "sid" },
      topic: "SCOPE_UPDATE",
      shop: "s",
    });
    mocks.mockSessionUpdate.mockResolvedValue({});
    const { action } = await import("./webhooks.app.scopes_update");
    await action({ request: new Request("https://x") } as never);
    expect(mocks.mockSessionUpdate).toHaveBeenCalled();
  });

  it("subscriptions_update downgrades on terminal status", async () => {
    mocks.mockWebhook.mockResolvedValue({
      shop: "s",
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { status: "CANCELLED" } },
    });
    const { action } = await import("./webhooks.app.subscriptions_update");
    const res = await action({ request: new Request("https://x") } as never);
    expect(mocks.mockCancelSubscription).toHaveBeenCalledWith("s");
    expect(res.status).toBe(200);
  });

  it("subscriptions_update 422 on wrong topic", async () => {
    mocks.mockWebhook.mockResolvedValue({
      shop: "s",
      topic: "OTHER",
      payload: {},
    });
    const { action } = await import("./webhooks.app.subscriptions_update");
    const res = await action({ request: new Request("https://x") } as never);
    expect(res.status).toBe(422);
  });

  it("subscriptions_update ignores active status", async () => {
    mocks.mockWebhook.mockResolvedValue({
      shop: "s",
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { status: "ACTIVE" } },
    });
    const { action } = await import("./webhooks.app.subscriptions_update");
    await action({ request: new Request("https://x") } as never);
    expect(mocks.mockCancelSubscription).not.toHaveBeenCalled();
  });

  it("gdpr webhooks respond ok", async () => {
    mocks.mockWebhook.mockResolvedValue({ shop: "s", topic: "CUSTOMERS_DATA_REQUEST" });
    const { action: dataReq } = await import("./webhooks.customers.data_request");
    expect((await dataReq({ request: new Request("https://x") } as never)).status).toBe(200);
    const { action: redactC } = await import("./webhooks.customers.redact");
    expect((await redactC({ request: new Request("https://x") } as never)).status).toBe(200);
    mocks.mockWebhook.mockResolvedValue({ shop: "s", topic: "SHOP_REDACT" });
    mocks.mockStoreFindUnique.mockResolvedValue(null);
    const { action: shopRedact } = await import("./webhooks.shop.redact");
    expect((await shopRedact({ request: new Request("https://x") } as never)).status).toBe(200);
  });

  it("shop.redact deletes store data when present", async () => {
    mocks.mockWebhook.mockResolvedValue({ shop: "s", topic: "SHOP_REDACT" });
    mocks.mockStoreFindUnique.mockResolvedValue({ id: "st1" });
    mocks.mockSimulationFindMany.mockResolvedValue([{ id: "sim1" }]);
    mocks.mockAgentLogDeleteMany.mockResolvedValue({});
    mocks.mockSimulationDeleteMany.mockResolvedValue({});
    mocks.mockCompetitorDeleteMany.mockResolvedValue({});
    mocks.mockStoreDelete.mockResolvedValue({});
    const { action: shopRedact } = await import("./webhooks.shop.redact");
    await shopRedact({ request: new Request("https://x") } as never);
    expect(mocks.mockAgentLogDeleteMany).toHaveBeenCalled();
    expect(mocks.mockStoreDelete).toHaveBeenCalled();
  });
});
