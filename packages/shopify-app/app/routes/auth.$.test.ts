import { describe, expect, it, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  authenticate: { admin: vi.fn().mockResolvedValue({}) },
}));

import { authenticate } from "../shopify.server";
import { loader } from "./auth.$";

describe("auth.$ loader", () => {
  it("authenticates admin", async () => {
    await expect(loader({ request: new Request("https://x") } as never)).resolves.toBeNull();
    expect(authenticate.admin).toHaveBeenCalled();
  });
});
