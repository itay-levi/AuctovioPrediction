import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateMany } = vi.hoisted(() => ({ mockUpdateMany: vi.fn() }));

vi.mock("../db.server", () => ({
  default: {
    simulation: { updateMany: mockUpdateMany },
  },
}));

import { action, loader } from "./api.cron.cleanup";

describe("api.cron.cleanup", () => {
  beforeEach(() => {
    mockUpdateMany.mockReset();
  });

  it("loader returns 405", async () => {
    const res = await loader({} as never);
    expect(res.status).toBe(405);
  });

  it("action rejects bad auth", async () => {
    const res = await action({
      request: new Request("https://x", { headers: {} }),
    } as never);
    expect(res.status).toBe(401);
  });

  it("action expires stuck sims", async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });
    const res = await action({
      request: new Request("https://x", { headers: { Authorization: "Bearer test-cron-secret" } }),
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expired).toBe(2);
  });
});
