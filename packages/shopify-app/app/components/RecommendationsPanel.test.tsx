import { render, screen } from "@testing-library/react";
import * as Remix from "@remix-run/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendationsPanel } from "./RecommendationsPanel";

describe("RecommendationsPanel", () => {
  beforeEach(() => {
    vi.spyOn(Remix, "useFetcher").mockReturnValue({
      state: "idle",
      data: undefined,
      submit: vi.fn(),
      Form: ({ children }: React.PropsWithChildren) => <form>{children}</form>,
    } as ReturnType<typeof Remix.useFetcher>);
  });

  const trustAudit = {
    trustScore: 85,
    hasReturnPolicy: true,
    hasSpecificReturn: true,
    hasShippingInfo: true,
    hasSpecificShipping: true,
    hasReviews: true,
    hasStrongSocialProof: true,
    hasContact: true,
    hasTrustBadges: true,
    trustKillers: [
      {
        signal: "return_policy",
        label: "Returns",
        severity: "high" as const,
        fix: "fix it",
      },
      {
        signal: "reviews",
        label: "Reviews",
        severity: "medium" as const,
        fix: "wait",
        category: "grows_over_time" as const,
      },
    ],
  };

  it("returns null when nothing to show", () => {
    const { container } = render(
      <RecommendationsPanel
        recommendations={[]}
        trustAudit={null}
        score={90}
        productTitle="P"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders hooks, progress, killers, and recommendations", () => {
    render(
      <RecommendationsPanel
        recommendations={[
          {
            priority: "High",
            title: "T1",
            impact: "I1",
            the_why: "W1",
          },
          {
            priority: "Medium",
            title: "T2",
            impact: "I2",
            the_why: "W2",
          },
          {
            priority: "Low",
            title: "T3",
            impact: "I3",
            the_why: "W3",
          },
        ]}
        trustAudit={trustAudit}
        score={40}
        productTitle="Soap"
        shopDomain="s.myshopify.com"
        scoreDelta={3}
        resolvedKillers={[
          {
            signal: "old",
            label: "Old issue",
            severity: "high",
            fix: "gone",
          },
        ]}
      />,
    );
    expect(screen.getByText(/losing 60%/)).toBeInTheDocument();
    expect(screen.getByText(/improved by \+3/)).toBeInTheDocument();
    expect(screen.getByText(/Fix Now/)).toBeInTheDocument();
    expect(screen.getByText(/Grows Over Time/)).toBeInTheDocument();
    expect(screen.getByText("T1")).toBeInTheDocument();
  });

  it("uses score hook for mid and high tiers", () => {
    const rec = { priority: "Low" as const, title: "x", impact: "y", the_why: "z" };
    const { rerender } = render(
      <RecommendationsPanel recommendations={[rec]} trustAudit={null} score={60} productTitle="P" />,
    );
    expect(screen.getByText(/room to push past 80/)).toBeInTheDocument();
    rerender(<RecommendationsPanel recommendations={[rec]} trustAudit={null} score={90} productTitle="P" />);
    expect(screen.getByText(/top tier/)).toBeInTheDocument();
  });

  it("shows negative score delta banner", () => {
    render(
      <RecommendationsPanel
        recommendations={[{ priority: "Low", title: "x", impact: "y", the_why: "z" }]}
        trustAudit={{
          ...trustAudit,
          trustScore: 40,
          trustKillers: [],
        }}
        score={55}
        productTitle="P"
        scoreDelta={-2}
      />,
    );
    expect(screen.getByText(/dropped by 2 points/)).toBeInTheDocument();
  });
});
