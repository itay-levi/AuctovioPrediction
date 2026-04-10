import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_LABELS, requireTier } from "./gates.server";

vi.mock("./store.server", () => ({
  getStore: vi.fn(),
}));

import { getStore } from "./store.server";

describe("gates.server", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("exports feature labels", () => {
    expect(FEATURE_LABELS.sandbox).toContain("Pro");
  });

  it("no-ops in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(requireTier("s.myshopify.com", "PRO", "sandbox")).resolves.toBeUndefined();
  });

  it("redirects when tier too low in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(getStore).mockResolvedValue({ planTier: "FREE" } as Awaited<ReturnType<typeof getStore>>);
    try {
      await requireTier("s.myshopify.com", "PRO", "sandbox");
      expect.fail("expected redirect");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(302);
      expect((e as Response).headers.get("Location")).toContain("/app/billing?feature=sandbox");
    }
  });

  it("allows when tier sufficient", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(getStore).mockResolvedValue({ planTier: "ENTERPRISE" } as Awaited<ReturnType<typeof getStore>>);
    await expect(requireTier("s.myshopify.com", "PRO")).resolves.toBeUndefined();
  });
});
