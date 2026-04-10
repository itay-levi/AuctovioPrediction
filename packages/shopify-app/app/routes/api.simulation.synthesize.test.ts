import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../db.server", () => ({
  default: {
    simulation: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}));

vi.mock("../shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockResolvedValue({ session: { shop: "s.myshopify.com" } }),
  },
}));

vi.mock("../services/store.server", () => ({
  getStore: vi.fn(),
}));

import { getStore } from "../services/store.server";
import { action } from "./api.simulation.$id.synthesize";

describe("api.simulation.$id.synthesize", () => {
  beforeEach(() => {
    vi.stubEnv("ENGINE_URL", "http://engine.test");
    vi.stubEnv("ENGINE_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ synthesis: "from-engine" }),
        text: async () => "",
      } as Response),
    );
    mockFindUnique.mockReset();
    mockUpdate.mockReset();
    vi.mocked(getStore).mockReset();
    mockUpdate.mockResolvedValue({});
  });

  it("403 when plan not allowed", async () => {
    vi.mocked(getStore).mockResolvedValue({ id: "st", planTier: "FREE" } as never);
    const res = await action({
      request: new Request("https://x", { method: "POST", body: new FormData() }),
      params: { id: "sim1" },
    } as never);
    expect(res.status).toBe(403);
  });

  it("allows FREE in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.mocked(getStore).mockResolvedValue({
      id: "st",
      planTier: "FREE",
      shopType: "x",
    } as never);
    mockFindUnique.mockResolvedValue({
      id: "sim1",
      storeId: "st",
      agentLogs: [],
      productJson: { title: "P" },
    } as never);
    const fd = new FormData();
    fd.set("regenerate", "1");
    const res = await action({
      request: new Request("https://x", { method: "POST", body: fd }),
      params: { id: "sim1" },
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synthesis).toBe("from-engine");
  });

  it("404 when simulation missing", async () => {
    vi.mocked(getStore).mockResolvedValue({ id: "st", planTier: "PRO" } as never);
    mockFindUnique.mockResolvedValue(null);
    const res = await action({
      request: new Request("https://x", { method: "POST", body: new FormData() }),
      params: { id: "sim1" },
    } as never);
    expect(res.status).toBe(404);
  });

  it("returns cached synthesis without regenerate", async () => {
    vi.mocked(getStore).mockResolvedValue({ id: "st", planTier: "PRO" } as never);
    mockFindUnique.mockResolvedValue({
      id: "sim1",
      storeId: "st",
      synthesisText: "cached",
      agentLogs: [],
      productJson: { title: "P" },
    } as never);
    const res = await action({
      request: new Request("https://x", { method: "POST", body: new FormData() }),
      params: { id: "sim1" },
    } as never);
    const body = await res.json();
    expect(body.synthesis).toBe("cached");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps engine failure to 500", async () => {
    vi.mocked(getStore).mockResolvedValue({ id: "st", planTier: "PRO" } as never);
    mockFindUnique.mockResolvedValue({
      id: "sim1",
      storeId: "st",
      agentLogs: [],
      productJson: {},
    } as never);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "bad",
    } as Response);
    const fd = new FormData();
    fd.set("regenerate", "1");
    const res = await action({
      request: new Request("https://x", { method: "POST", body: fd }),
      params: { id: "sim1" },
    } as never);
    expect(res.status).toBe(500);
  });
});
