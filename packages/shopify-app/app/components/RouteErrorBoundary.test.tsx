import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useRouteError: vi.fn(), isRouteErrorResponse: actual.isRouteErrorResponse };
});

import { useRouteError } from "@remix-run/react";

// Build a route error response that satisfies isRouteErrorResponse():
// requires status:number, statusText:string, internal:boolean, "data" in error.
const routeErr = (status: number, data: unknown = "") => ({
  status,
  statusText: "",
  internal: false,
  data,
});

describe("RouteErrorBoundary", () => {
  it("shows 404 copy", () => {
    vi.mocked(useRouteError).mockReturnValue(routeErr(404) as never);
    render(<RouteErrorBoundary />);
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("shows 403 copy", () => {
    vi.mocked(useRouteError).mockReturnValue(routeErr(403) as never);
    render(<RouteErrorBoundary />);
    expect(screen.getByText("Access denied")).toBeInTheDocument();
  });

  it("shows generic route error with data", () => {
    vi.mocked(useRouteError).mockReturnValue(routeErr(500, "oops") as never);
    render(<RouteErrorBoundary />);
    expect(screen.getByText("oops")).toBeInTheDocument();
  });

  it("shows Error message", () => {
    vi.mocked(useRouteError).mockReturnValue(new Error("boom"));
    render(<RouteErrorBoundary />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("falls back for unknown errors", () => {
    vi.mocked(useRouteError).mockReturnValue("weird" as never);
    render(<RouteErrorBoundary />);
    expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
  });
});
