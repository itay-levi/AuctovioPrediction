import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("engine.server", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ queued: true, estimatedMtCost: 4 }),
        text: async () => "",
      } as Response),
    );
    vi.stubEnv("ENGINE_URL", "http://127.0.0.1:9");
    vi.stubEnv("ENGINE_API_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("triggerSimulation posts payload", async () => {
    const { triggerSimulation } = await import("./engine.server");
    const r = await triggerSimulation({
      simulationId: "1",
      shopDomain: "s",
      shopType: "t",
      productUrl: "u",
      productJson: {},
      agentCount: 5,
      callbackUrl: "cb",
    });
    expect(r.queued).toBe(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("generateFix throws when not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "nope",
    } as Response);
    const { generateFix } = await import("./engine.server");
    await expect(generateFix("sig", "type")).rejects.toThrow(/500/);
  });

  it("compareLabSimulations returns json", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ scoreDelta: 1, whyGap: "x", divergenceTopics: [], targetPersonaCard: "", baselineLabel: "", targetLabel: "" }),
      text: async () => "",
    } as Response);
    const { compareLabSimulations } = await import("./engine.server");
    const r = await compareLabSimulations({
      productTitle: "p",
      baselineReport: {},
      targetReport: {},
      baselineScore: 1,
      targetScore: 2,
      labConfig: {
        audience: "general",
        skepticism: 1,
        coreConcern: "",
        brutalityLevel: 1,
        preset: "",
      },
    });
    expect(r.scoreDelta).toBe(1);
  });

  it("classifyStoreNiche returns niche", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ niche: "beauty" }),
      text: async () => "",
    } as Response);
    const { classifyStoreNiche } = await import("./engine.server");
    await expect(classifyStoreNiche("s", ["a"])).resolves.toBe("beauty");
  });

  it("checkEngineHealth returns boolean", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
    const { checkEngineHealth } = await import("./engine.server");
    await expect(checkEngineHealth()).resolves.toBe(true);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("down"));
    await expect(checkEngineHealth()).resolves.toBe(false);
  });

  it("triggerDeltaSimulation posts and parses body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ queued: true, estimatedMtCost: 2 }),
      text: async () => "",
    } as Response);
    const { triggerDeltaSimulation } = await import("./engine.server");
    const r = await triggerDeltaSimulation({
      simulationId: "n",
      originalSimulationId: "o",
      shopDomain: "s",
      shopType: "t",
      productJson: {},
      agentCount: 5,
      deltaParams: { price: 9 },
      callbackUrl: "cb",
    });
    expect(r.queued).toBe(true);
  });

  it("evaluateRetake returns json", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        verdicts: [],
        overallVerdict: "Pass",
        overallPolishingTouch: "x",
      }),
      text: async () => "",
    } as Response);
    const { evaluateRetake } = await import("./engine.server");
    const r = await evaluateRetake({
      productTitle: "p",
      originalScore: 1,
      newScore: 2,
      originalRecommendations: [],
      originalFriction: {},
      newFriction: {},
      newVotes: [],
    });
    expect(r.overallVerdict).toBe("Pass");
  });

  it("generateFix returns json on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        heading: "h",
        text: "t",
        shopifySettingsPath: "/",
      }),
      text: async () => "",
    } as Response);
    const { generateFix } = await import("./engine.server");
    await expect(generateFix("sig", "pt")).resolves.toMatchObject({ heading: "h" });
  });
});
