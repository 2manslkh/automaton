import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withRetry,
  isTransientError,
  calculateDelay,
  CircuitBreaker,
  CircuitOpenError,
  RetryTimeoutError,
} from "../utils/retry.js";

describe("isTransientError", () => {
  it("returns true for network errors", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for retryable HTTP status codes", () => {
    expect(isTransientError(new Error("Conway API error: GET /v1/credits/balance -> 429: rate limited"))).toBe(true);
    expect(isTransientError(new Error("Inference error: 503: service unavailable"))).toBe(true);
    expect(isTransientError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientError(new Error("Invalid API key"))).toBe(false);
    expect(isTransientError(new Error("400: bad request"))).toBe(false);
    expect(isTransientError(new Error("401: unauthorized"))).toBe(false);
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe("calculateDelay", () => {
  it("increases exponentially", () => {
    const d0 = 1000 * Math.pow(2, 0); // 1000
    const d1 = 1000 * Math.pow(2, 1); // 2000
    const d2 = 1000 * Math.pow(2, 2); // 4000
    // With jitter between 50-100%, check ranges
    for (let i = 0; i < 20; i++) {
      const delay = calculateDelay(2, 1000, 30000);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it("respects max delay cap", () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateDelay(20, 1000, 5000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { timeoutMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("503: service unavailable"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 10, timeoutMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries", async () => {
    const err = new Error("503: service unavailable");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, timeoutMs: 0 }),
    ).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("401: unauthorized"));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10, timeoutMs: 0 }),
    ).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry callback", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("429: rate limited"))
      .mockResolvedValue("ok");

    await withRetry(fn, { baseDelayMs: 10, timeoutMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
  });

  it("respects custom isRetryable", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("custom error"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      baseDelayMs: 10,
      timeoutMs: 0,
      isRetryable: (e) => e instanceof Error && e.message === "custom error",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("closed");
  });

  it("opens after threshold failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    for (let i = 0; i < 3; i++) {
      await expect(cb.exec(fn)).rejects.toThrow("fail");
    }
    expect(cb.getState()).toBe("open");

    await expect(cb.exec(fn)).rejects.toThrow(CircuitOpenError);
  });

  it("transitions to half-open after reset timeout", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(cb.exec(fn)).rejects.toThrow("fail");
    await expect(cb.exec(fn)).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(1500);

    // Next call should go through (half-open)
    const successFn = vi.fn().mockResolvedValue("ok");
    const result = await cb.exec(successFn);
    expect(result).toBe("ok");
    expect(cb.getState()).toBe("closed");
    vi.useRealTimers();
  });

  it("re-opens on failure in half-open state", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(cb.exec(fn)).rejects.toThrow("fail");
    await expect(cb.exec(fn)).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(1500);

    // Half-open, but fails again
    await expect(cb.exec(fn)).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");
    vi.useRealTimers();
  });

  it("resets cleanly", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(cb.exec(fn)).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");

    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.getFailureCount()).toBe(0);
  });

  it("succeeds through circuit breaker", async () => {
    const cb = new CircuitBreaker();
    const result = await cb.exec(async () => "hello");
    expect(result).toBe("hello");
    expect(cb.getState()).toBe("closed");
  });
});
