import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.server";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns fn result when closed", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 50 });
    await expect(cb.execute(async () => 42)).resolves.toBe(42);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("opens after threshold failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 10_000 });
    await expect(cb.execute(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(cb.execute(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(cb.getState()).toBe("OPEN");
    await expect(cb.execute(async () => 1)).rejects.toThrow(/OPEN/);
  });

  it("moves to half-open after reset timeout then closes on success", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 100 });
    await expect(cb.execute(async () => {
      throw new Error("x");
    })).rejects.toThrow("x");
    expect(cb.getState()).toBe("OPEN");
    await vi.advanceTimersByTimeAsync(100);
    await expect(cb.execute(async () => "ok")).resolves.toBe("ok");
    expect(cb.getState()).toBe("CLOSED");
    vi.useRealTimers();
  });

  it("in development bypasses breaker", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 10_000 });
    await expect(cb.execute(async () => {
      throw new Error("fail");
    })).rejects.toThrow("fail");
    expect(cb.getState()).toBe("CLOSED");
  });
});
