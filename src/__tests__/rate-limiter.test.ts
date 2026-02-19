import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SlidingWindowRateLimiter,
  TokenBucketRateLimiter,
  RateLimiterRegistry,
  QuotaTracker,
} from "../utils/rate-limiter.js";

// ─── Sliding Window ────────────────────────────────────────────

describe("SlidingWindowRateLimiter", () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 3 });
  });

  it("allows requests within limit", () => {
    expect(limiter.check("key1")).toBeNull();
    expect(limiter.check("key1")).toBeNull();
    expect(limiter.check("key1")).toBeNull();
  });

  it("blocks requests over limit", () => {
    limiter.check("key1");
    limiter.check("key1");
    limiter.check("key1");
    const result = limiter.check("key1");
    expect(result).toContain("Rate limited");
  });

  it("tracks different keys independently", () => {
    limiter.check("a");
    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a")).not.toBeNull();
    expect(limiter.check("b")).toBeNull();
  });

  it("getCount returns current count", () => {
    limiter.check("x");
    limiter.check("x");
    expect(limiter.getCount("x")).toBe(2);
  });

  it("reset clears a specific key", () => {
    limiter.check("x");
    limiter.check("x");
    limiter.check("x");
    limiter.reset("x");
    expect(limiter.check("x")).toBeNull();
  });

  it("reset without key clears all", () => {
    limiter.check("a");
    limiter.check("b");
    limiter.reset();
    expect(limiter.getCount("a")).toBe(0);
    expect(limiter.getCount("b")).toBe(0);
  });
});

// ─── Token Bucket ──────────────────────────────────────────────

describe("TokenBucketRateLimiter", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({ maxTokens: 5, refillRate: 10 });
  });

  it("allows requests when tokens available", () => {
    expect(limiter.consume("key1")).toBeNull();
    expect(limiter.consume("key1")).toBeNull();
  });

  it("blocks when tokens exhausted", () => {
    for (let i = 0; i < 5; i++) limiter.consume("key1");
    const result = limiter.consume("key1");
    expect(result).toContain("Rate limited");
  });

  it("getAvailable returns remaining tokens", () => {
    limiter.consume("k", 3);
    expect(limiter.getAvailable("k")).toBeCloseTo(2, 0);
  });

  it("allows consuming multiple tokens at once", () => {
    expect(limiter.consume("k", 5)).toBeNull();
    expect(limiter.consume("k", 1)).toContain("Rate limited");
  });

  it("initializes new keys with max tokens", () => {
    expect(limiter.getAvailable("new_key")).toBe(5);
  });
});

// ─── Registry ──────────────────────────────────────────────────

describe("RateLimiterRegistry", () => {
  let registry: RateLimiterRegistry;

  beforeEach(() => {
    registry = new RateLimiterRegistry();
  });

  it("returns null for unregistered keys", () => {
    expect(registry.check("nonexistent")).toBeNull();
  });

  it("enforces sliding window rules", () => {
    registry.register("api", { type: "sliding_window", windowMs: 1000, maxRequests: 2 });
    expect(registry.check("api", "client1")).toBeNull();
    expect(registry.check("api", "client1")).toBeNull();
    expect(registry.check("api", "client1")).toContain("Rate limited");
  });

  it("enforces token bucket rules", () => {
    registry.register("burst", { type: "token_bucket", maxTokens: 2, refillRate: 1 });
    expect(registry.check("burst", "x")).toBeNull();
    expect(registry.check("burst", "x")).toBeNull();
    expect(registry.check("burst", "x")).toContain("Rate limited");
  });

  it("getRule returns registered rule", () => {
    registry.register("test", { type: "sliding_window", windowMs: 5000, maxRequests: 10 });
    const rule = registry.getRule("test");
    expect(rule).toBeDefined();
    expect(rule!.type).toBe("sliding_window");
  });
});

// ─── Quota Tracker ─────────────────────────────────────────────

describe("QuotaTracker", () => {
  let tracker: QuotaTracker;
  let store: Map<string, string>;
  let kvStore: { getKV: (k: string) => string | undefined; setKV: (k: string, v: string) => void };

  beforeEach(() => {
    store = new Map();
    kvStore = {
      getKV: (k: string) => store.get(k),
      setKV: (k: string, v: string) => store.set(k, v),
    };
    tracker = new QuotaTracker(kvStore);
  });

  it("allows requests within quota", () => {
    tracker.define({ name: "calls", period: "daily", limit: 10 });
    const result = tracker.increment("calls");
    expect(result.allowed).toBe(true);
    expect(result.usage.used).toBe(1);
  });

  it("blocks requests exceeding quota", () => {
    tracker.define({ name: "calls", period: "daily", limit: 3 });
    tracker.increment("calls");
    tracker.increment("calls");
    tracker.increment("calls");
    const result = tracker.increment("calls");
    expect(result.allowed).toBe(false);
    expect(result.warning).toContain("Quota exceeded");
  });

  it("warns at 80% usage by default", () => {
    tracker.define({ name: "calls", period: "daily", limit: 10 });
    for (let i = 0; i < 7; i++) tracker.increment("calls");
    const result = tracker.increment("calls"); // 8th = 80%
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("Quota warning");
  });

  it("custom warnAt threshold", () => {
    tracker.define({ name: "calls", period: "daily", limit: 10, warnAt: 0.5 });
    for (let i = 0; i < 4; i++) tracker.increment("calls");
    const result = tracker.increment("calls"); // 5th = 50%
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("Quota warning");
  });

  it("persists to store", () => {
    tracker.define({ name: "calls", period: "daily", limit: 100 });
    tracker.increment("calls", 5);
    const raw = store.get("quota:calls");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.used).toBe(5);
  });

  it("loads from store on new tracker instance", () => {
    tracker.define({ name: "calls", period: "daily", limit: 100 });
    tracker.increment("calls", 42);

    // New tracker with same store
    const tracker2 = new QuotaTracker(kvStore);
    tracker2.define({ name: "calls", period: "daily", limit: 100 });
    const status = tracker2.check("calls");
    expect(status.usage.used).toBe(42);
  });

  it("check without increment", () => {
    tracker.define({ name: "calls", period: "daily", limit: 10 });
    tracker.increment("calls", 5);
    const result = tracker.check("calls");
    expect(result.usage.used).toBe(5);
    // Check again - should be same
    expect(tracker.check("calls").usage.used).toBe(5);
  });

  it("getAllStatus returns all quotas", () => {
    tracker.define({ name: "a", period: "daily", limit: 10 });
    tracker.define({ name: "b", period: "hourly", limit: 5 });
    tracker.increment("a", 3);
    tracker.increment("b", 2);
    const statuses = tracker.getAllStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.name === "a")!.used).toBe(3);
    expect(statuses.find((s) => s.name === "b")!.used).toBe(2);
  });

  it("resetQuota resets usage to 0", () => {
    tracker.define({ name: "calls", period: "daily", limit: 10 });
    tracker.increment("calls", 8);
    tracker.resetQuota("calls");
    expect(tracker.check("calls").usage.used).toBe(0);
  });

  it("allows undefined quota names gracefully", () => {
    const result = tracker.increment("nonexistent");
    expect(result.allowed).toBe(true);
  });

  it("increment with custom amount", () => {
    tracker.define({ name: "spend", period: "daily", limit: 1000 });
    tracker.increment("spend", 500);
    tracker.increment("spend", 400);
    const result = tracker.increment("spend", 200);
    expect(result.allowed).toBe(false);
  });
});
