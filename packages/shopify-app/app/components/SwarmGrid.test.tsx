import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SwarmGrid } from "./SwarmGrid";

describe("SwarmGrid", () => {
  it("renders dots and summary counts", () => {
    const logs = [
      { agentId: "agent_0", archetype: "BudgetOptimizer", verdict: "BUY", reasoning: "ok" },
      { agentId: "agent_1", archetype: "BrandLoyalist", verdict: "REJECT", reasoning: "no" },
    ];
    render(<SwarmGrid agentCount={3} logs={logs} />);
    expect(screen.getByLabelText(/BudgetOptimizer/)).toBeInTheDocument();
    expect(screen.getByText(/would buy/)).toBeInTheDocument();
    expect(screen.getByText(/rejected/)).toBeInTheDocument();
  });

  it("uses pending label when no log", () => {
    render(<SwarmGrid agentCount={1} logs={[]} />);
    const dot = screen.getByLabelText(/Agent 1 \(pending\)/);
    expect(dot).toBeInTheDocument();
  });
});
