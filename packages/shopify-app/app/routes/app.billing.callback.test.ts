import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockGraphql = vi.fn();

vi.mock("../shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockResolvedValue({
      admin: { graphql: mockGraphql },
      session: { shop: "s.myshopify.com" },
    }),
  },
}));

vi.mock("../services/billing.server", () => ({
  upgradePlanTier: vi.fn(),
}));

import { upgradePlanTier } from "../services/billing.server";
import BillingCallback, { loader } from "./app.billing.callback";

describe("app.billing.callback", () => {
  it("default export renders nothing", () => {
    expect(renderToStaticMarkup(createElement(BillingCallback))).toBe("");
  });

  it("loader redirects when plan invalid", async () => {
    try {
      await loader({ request: new Request("https://x/app/billing/callback") } as never);
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).headers.get("Location")).toContain("/app/billing");
    }
  });

  it("loader redirects when charge_id missing", async () => {
    try {
      await loader({
        request: new Request("https://x/app/billing/callback?plan=PRO"),
      } as never);
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
    }
  });

  it("loader upgrades when subscription active", async () => {
    mockGraphql.mockResolvedValue({
      json: async () => ({ data: { node: { status: "ACTIVE" } } }),
    });
    try {
      await loader({
        request: new Request("https://x/app/billing/callback?plan=PRO&charge_id=gid://x"),
      } as never);
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect(upgradePlanTier).toHaveBeenCalledWith("s.myshopify.com", "PRO");
    }
  });

  it("loader redirects with payment error when pending", async () => {
    mockGraphql.mockResolvedValue({
      json: async () => ({ data: { node: { status: "PENDING" } } }),
    });
    try {
      await loader({
        request: new Request("https://x/app/billing/callback?plan=ENTERPRISE&charge_id=gid://y"),
      } as never);
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).headers.get("Location")).toContain("error=payment_not_confirmed");
    }
  });

  it("loader redirects on graphql failure", async () => {
    mockGraphql.mockRejectedValue(new Error("network"));
    try {
      await loader({
        request: new Request("https://x/app/billing/callback?plan=PRO&charge_id=gid://z"),
      } as never);
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
    }
  });
});
