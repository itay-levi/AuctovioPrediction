type State = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
}

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeout = options.resetTimeout ?? 60_000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // In development, bypass the circuit breaker entirely so a restarted engine
    // is immediately available without waiting for the 60 s reset window.
    if (process.env.NODE_ENV === "development") {
      return fn();
    }

    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error("Circuit breaker is OPEN — engine temporarily unavailable. Try again in a moment.");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  getState(): State {
    return this.state;
  }
}

// Singleton for the Auctovio engine
export const engineBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60_000 });
