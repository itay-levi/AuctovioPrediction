import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FrictionReport } from "./FrictionReport";

const friction = {
  price: { dropoutPct: 50, topObjections: ["a", "b"] },
  trust: { dropoutPct: 20, topObjections: ["t"] },
  logistics: { dropoutPct: 5, topObjections: [] },
};

describe("FrictionReport", () => {
  it("shows objections for Pro", () => {
    render(<FrictionReport friction={friction} isPro />);
    expect(screen.getByText(/Price Sensitivity/i)).toBeInTheDocument();
    expect(screen.getByText(/• a/)).toBeInTheDocument();
  });

  it("blurs extra objections for free tier", () => {
    render(<FrictionReport friction={friction} isPro={false} />);
    expect(screen.getByText(/upgrade to Pro/i)).toBeInTheDocument();
  });
});
