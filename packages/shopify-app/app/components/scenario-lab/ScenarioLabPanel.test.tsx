import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScenarioLabPanel } from "./ScenarioLabPanel";

describe("ScenarioLabPanel", () => {
  const base = {
    labEnabled: false,
    onLabEnabledChange: vi.fn(),
    labPreset: "" as const,
    onSelectPreset: vi.fn(),
    onClearPreset: vi.fn(),
    labAudience: "general" as const,
    onAudienceChange: vi.fn(),
    labSkepticism: 5 as const,
    onSkepticismChange: vi.fn(),
    labConcern: "",
    onConcernChange: vi.fn(),
    labBrutality: 5,
    onBrutalityChange: vi.fn(),
  };

  it("toggles lab switch", async () => {
    const user = userEvent.setup();
    const onLabEnabledChange = vi.fn();
    render(<ScenarioLabPanel {...base} onLabEnabledChange={onLabEnabledChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onLabEnabledChange).toHaveBeenCalledWith(true);
  });

  it("selects preset then clears on second click", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const onClearPreset = vi.fn();
    const { rerender } = render(
      <ScenarioLabPanel
        {...base}
        labEnabled
        labPreset=""
        onSelectPreset={onSelectPreset}
        onClearPreset={onClearPreset}
      />,
    );
    await user.click(screen.getByText("Holiday rush").closest("button")!);
    expect(onSelectPreset).toHaveBeenCalledWith("holiday_rush");

    rerender(
      <ScenarioLabPanel
        {...base}
        labEnabled
        labPreset="holiday_rush"
        onSelectPreset={onSelectPreset}
        onClearPreset={onClearPreset}
      />,
    );
    await user.click(screen.getByText("Holiday rush").closest("button")!);
    expect(onClearPreset).toHaveBeenCalled();
  });

  it("changes audience, skepticism, concern, brutality", async () => {
    const user = userEvent.setup();
    const onAudienceChange = vi.fn();
    const onSkepticismChange = vi.fn();
    const onConcernChange = vi.fn();
    const onBrutalityChange = vi.fn();
    render(
      <ScenarioLabPanel
        {...base}
        labEnabled
        onAudienceChange={onAudienceChange}
        onSkepticismChange={onSkepticismChange}
        onConcernChange={onConcernChange}
        onBrutalityChange={onBrutalityChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Target audience"), { target: { value: "luxury" } });
    expect(onAudienceChange).toHaveBeenCalledWith("luxury");
    await user.click(screen.getByRole("button", { name: /Lenient/i }));
    expect(onSkepticismChange).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByLabelText("Core concern"), { target: { value: "price" } });
    expect(onConcernChange).toHaveBeenCalledWith("price");
    fireEvent.change(screen.getByLabelText("Brutality level"), { target: { value: "9" } });
    expect(onBrutalityChange).toHaveBeenCalledWith(9);
  });

  it("shows collapsed hint when disabled", () => {
    render(<ScenarioLabPanel {...base} />);
    expect(screen.getByText(/Enable the lab/i)).toBeInTheDocument();
  });
});
