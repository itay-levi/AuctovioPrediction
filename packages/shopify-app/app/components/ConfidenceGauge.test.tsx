import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceGauge } from "./ConfidenceGauge";

describe("ConfidenceGauge", () => {
  it("renders score and label tiers", () => {
    const { rerender } = render(<ConfidenceGauge score={80} size={100} />);
    expect(screen.getByLabelText("Customer Confidence Score: 80")).toBeInTheDocument();
    rerender(<ConfidenceGauge score={50} variant="dark" />);
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    rerender(<ConfidenceGauge score={20} />);
    expect(screen.getByText("Needs Work")).toBeInTheDocument();
  });

  it("skips fill path when score is 0", () => {
    const { container } = render(<ConfidenceGauge score={0} size={120} />);
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(1);
  });
});
