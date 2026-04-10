import { beforeEach, describe, expect, it, vi } from "vitest";

describe("sendWeeklyDigest", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "",
      } as Response),
    );
  });

  it("returns early when RESEND_API_KEY missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.resetModules();
    const { sendWeeklyDigest } = await import("./email.server");
    await sendWeeklyDigest("a@b.com", "shop.com", {
      healthScore: 1,
      simulationCount: 0,
      topFriction: null,
      topProducts: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to Resend and escapes html", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("FROM_EMAIL", "from@example.com");
    vi.resetModules();
    const { sendWeeklyDigest } = await import("./email.server");
    await sendWeeklyDigest("a@b.com", "shop<script>.com", {
      healthScore: 50,
      simulationCount: 2,
      topFriction: "price",
      topProducts: [{ name: 'A & B "co"', score: 90 }],
    });
    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain("&amp;");
    expect(body.html).toContain("price");
  });

  it("throws when Resend returns error", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.resetModules();
    const { sendWeeklyDigest } = await import("./email.server");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "err",
    } as Response);
    await expect(
      sendWeeklyDigest("a@b.com", "s.com", {
        healthScore: 1,
        simulationCount: 0,
        topFriction: null,
        topProducts: [],
      }),
    ).rejects.toThrow(/Resend error 500/);
  });
});
