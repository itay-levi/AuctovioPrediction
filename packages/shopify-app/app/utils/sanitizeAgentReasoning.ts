/** Merchant-safe panel copy — never echo internal/engine error strings. */
export function sanitizeAgentReasoning(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  if (
    lower.includes("malformed") ||
    lower.includes("invalid json") ||
    lower.includes("jsondecode") ||
    lower.includes("timed out after") ||
    lower.includes("agent response was")
  ) {
    return "This panelist is still weighing the listing — their full reaction was not recorded. Treat this as lingering hesitation.";
  }
  return t;
}
