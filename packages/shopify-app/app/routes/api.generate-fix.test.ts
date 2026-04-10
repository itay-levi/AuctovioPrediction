import { describe, expect, it, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockResolvedValue({ session: { shop: "s.myshopify.com" } }),
  },
}));

vi.mock("../services/store.server", () => ({
  getStore: vi.fn(),
}));

vi.mock("../services/engine.server", () => ({
  generateFix: vi.fn(),
}));

import { generateFix } from "../services/engine.server";
import { getStore } from "../services/store.server";
import { action } from "./api.generate-fix";

describe("api.generate-fix action", () => {
  it("rejects unsupported signal", async () => {
    const res = await action({
      request: new Request("https://x", {
        method: "POST",
        body: JSON.stringify({ signal: "nope" }),
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("returns fix json", async () => {
    vi.mocked(getStore).mockResolvedValue({ shopType: "beauty" } as never);
    vi.mocked(generateFix).mockResolvedValue({
      heading: "h",
      text: "t",
      shopifySettingsPath: "/",
    });
    const res = await action({
      request: new Request("https://x", {
        method: "POST",
        body: JSON.stringify({ signal: "return_policy" }),
      }),
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.heading).toBe("h");
  });

  it("maps engine errors to 500", async () => {
    vi.mocked(getStore).mockResolvedValue(null);
    vi.mocked(generateFix).mockRejectedValue(new Error("engine down"));
    const res = await action({
      request: new Request("https://x", {
        method: "POST",
        body: JSON.stringify({ signal: "no_shipping_info" }),
      }),
    } as never);
    expect(res.status).toBe(500);
  });
});
