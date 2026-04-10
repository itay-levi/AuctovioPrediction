import { sanitizeAgentReasoning } from "./sanitizeAgentReasoning";

describe("sanitizeAgentReasoning", () => {
  it("returns empty when trimmed empty", () => {
    expect(sanitizeAgentReasoning("   ")).toBe("");
  });

  it("returns original when no sensitive phrases", () => {
    expect(sanitizeAgentReasoning("Looks good.")).toBe("Looks good.");
  });

  it.each([
    ["malformed payload"],
    ["Invalid JSON here"],
    ["JsonDecode failed"],
    ["timed out after 30s"],
    ["agent response was empty"],
  ])("masks when text includes %s", (frag) => {
    const out = sanitizeAgentReasoning(`prefix ${frag} suffix`);
    expect(out).toMatch(/not recorded/i);
    expect(out).not.toContain(frag);
  });

  it("is case-insensitive for triggers", () => {
    expect(sanitizeAgentReasoning("MALFORMED")).toMatch(/not recorded/i);
  });
});
