import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Remix from "@remix-run/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntelligenceExport } from "./IntelligenceExport";

describe("IntelligenceExport", () => {
  beforeEach(() => {
    vi.spyOn(Remix, "useFetcher").mockReturnValue({
      state: "idle",
      data: undefined,
      submit: vi.fn(),
      Form: ({ children, action, method, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
        <form action={action as string} method={method as string} data-testid="fetcher-form" {...rest}>
          {children}
        </form>
      ),
    } as ReturnType<typeof Remix.useFetcher>);
  });

  it("shows upgrade card when not Pro", () => {
    render(
      <IntelligenceExport
        simulationId="sim-1"
        productTitle="My Product"
        agentLogs={[]}
        isPro={false}
        isEnterprise={false}
        existingSynthesis={null}
      />,
    );
    expect(screen.getByText(/Upgrade to Pro/i)).toBeInTheDocument();
  });

  it("exports csv and json", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:1");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <IntelligenceExport
        simulationId="sim-uuid-1234"
        productTitle="Test Item"
        agentLogs={[
          {
            agentId: "a1",
            archetype: "x",
            phase: 1,
            verdict: "BUY",
            reasoning: 'say "hi"',
          },
        ]}
        isPro
        isEnterprise={false}
        existingSynthesis={null}
      />,
    );

    await user.click(screen.getByText("Download CSV"));
    await user.click(screen.getByText("Download JSON"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    click.mockRestore();
  });
});
