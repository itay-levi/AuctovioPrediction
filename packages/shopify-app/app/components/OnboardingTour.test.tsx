import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnboardingTour } from "./OnboardingTour";

describe("OnboardingTour", () => {
  it("shows modal when storage empty and completes flow", async () => {
    const user = userEvent.setup();
    const storage: Record<string, string> = {};
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((k) => storage[k] ?? null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((k, v) => {
      storage[k] = v;
    });

    render(
      <OnboardingTour
        storageKey="tour-test"
        label="New"
        steps={[
          { title: "Step 1", body: "First" },
          { title: "Step 2", body: "Second" },
        ]}
      />,
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
    await user.click(screen.getByText("Next"));
    expect(screen.getByText("Second")).toBeInTheDocument();
    await user.click(screen.getByText("Got it"));
    expect(storage["tour-test"]).toBe("seen");
  });

  it("returns null for empty steps", () => {
    const { container } = render(<OnboardingTour storageKey="x" steps={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
