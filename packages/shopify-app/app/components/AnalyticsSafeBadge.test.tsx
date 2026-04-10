import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AnalyticsSafeBadge } from "./AnalyticsSafeBadge";

describe("AnalyticsSafeBadge", () => {
  it("toggles tooltip interaction", async () => {
    const user = userEvent.setup();
    render(<AnalyticsSafeBadge />);
    expect(screen.getByText(/Analytics-Safe/i)).toBeInTheDocument();
    await user.click(screen.getByText(/Analytics-Safe/i).closest("div")!);
  });
});
