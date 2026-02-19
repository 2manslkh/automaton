/**
 * Unified Rate Limiting Module
 *
 * Provides sliding window and token bucket rate limiters,
 * per-key rate limiting, and a quota system with DB persistence.
 */

// ─── Sliding Window Rate Limiter ───────────────────────────────

export interface SlidingWindowConfig {
  windowMs: number;
  maxRequests: number;
}

export class SlidingWindowRateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private config: SlidingWindowConfig;

  constructor(config: SlidingWindowConfig) {
    this.config = config;
  }

  /**
   * Check if a request is allowed for the given key.
   * Returns null if allowed, or a string with wait time if rate limited.
   */
  check(key: string): string | null {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    let timestamps = this.timestamps.get(key) || [];

    // Purge expired
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.config.maxRequests) {
      const oldestValid = timestamps[0]!;
      const waitMs = oldestValid + this.config.windowMs - now;
      this.timestamps.set(key, timestamps);
      return `Rate limited: ${this.config.maxRequests} requests per ${this.config.windowMs}ms exceeded. Retry in ${Math.ceil(waitMs / 1000)}s.`;
    }

    timestamps.push(now);
    this.timestamps.set(key, timestamps);
    return null;
  }

  /** Get current count for a key */
  getCount(key: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const timestamps = (this.timestamps.get(key) || []).filter((t) => t > cutoff);
    this.timestamps.set(key, timestamps);
    return timestamps.length;
  }

  /** Reset a specific key or all keys */
  reset(key?: string): void {
    if (key) {
      this.timestamps.delete(key);
    } else {
      this.timestamps.clear();
    }
  }
}

// ─── Token Bucket Rate Limiter ─────────────────────────────────

export interface TokenBucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per second
}

export class TokenBucketRateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private config: TokenBucketConfig;

  constructor(config: TokenBucketConfig) {
    this.config = config;
  }

  private refill(key: string): { tokens: number; lastRefill: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
      return bucket;
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + elapsed * this.config.refillRate);
    bucket.lastRefill = now;
    return bucket;
  }

  /**
   * Try to consume tokens. Returns null if allowed, error string if denied.
   */
  consume(key: string, tokens: number = 1): string | null {
    const bucket = this.refill(key);
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return null;
    }
    const waitSeconds = Math.ceil((tokens - bucket.tokens) / this.config.refillRate);
    return `Rate limited (token bucket): insufficient tokens. Retry in ${waitSeconds}s.`;
  }

  /** Get available tokens for a key */
  getAvailable(key: string): number {
    return this.refill(key).tokens;
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}

// ─── Per-Key Rate Limiter Registry ─────────────────────────────

export interface RateLimitRule {
  type: "sliding_window" | "token_bucket";
  windowMs?: number;
  maxRequests?: number;
  maxTokens?: number;
  refillRate?: number;
}

export class RateLimiterRegistry {
  private slidingWindowLimiters: Map<string, SlidingWindowRateLimiter> = new Map();
  private tokenBucketLimiters: Map<string, TokenBucketRateLimiter> = new Map();
  private rules: Map<string, RateLimitRule> = new Map();

  /** Register a rate limit rule for a key pattern */
  register(key: string, rule: RateLimitRule): void {
    this.rules.set(key, rule);
    if (rule.type === "sliding_window") {
      this.slidingWindowLimiters.set(
        key,
        new SlidingWindowRateLimiter({
          windowMs: rule.windowMs || 60_000,
          maxRequests: rule.maxRequests || 10,
        }),
      );
    } else {
      this.tokenBucketLimiters.set(
        key,
        new TokenBucketRateLimiter({
          maxTokens: rule.maxTokens || 10,
          refillRate: rule.refillRate || 1,
        }),
      );
    }
  }

  /** Check rate limit for a key. Returns null if allowed, error string if limited. */
  check(ruleKey: string, instanceKey: string = "default"): string | null {
    const sw = this.slidingWindowLimiters.get(ruleKey);
    if (sw) return sw.check(instanceKey);

    const tb = this.tokenBucketLimiters.get(ruleKey);
    if (tb) return tb.consume(instanceKey);

    return null; // No rule registered = allow
  }

  /** Reset all limiters */
  resetAll(): void {
    this.slidingWindowLimiters.forEach((l) => l.reset());
    this.tokenBucketLimiters.forEach((l) => l.reset());
  }

  getRule(key: string): RateLimitRule | undefined {
    return this.rules.get(key);
  }
}

// ─── Quota System ──────────────────────────────────────────────

export type QuotaPeriod = "hourly" | "daily" | "monthly";

export interface QuotaDefinition {
  name: string;
  period: QuotaPeriod;
  limit: number;
  warnAt?: number; // fraction, default 0.8
}

export interface QuotaUsage {
  name: string;
  used: number;
  limit: number;
  period: QuotaPeriod;
  periodStart: string; // ISO timestamp
  resetAt: string; // ISO timestamp
}

export interface QuotaCheckResult {
  allowed: boolean;
  warning?: string;
  usage: QuotaUsage;
}

function getPeriodStart(period: QuotaPeriod, now: Date = new Date()): Date {
  const start = new Date(now);
  if (period === "hourly") {
    start.setMinutes(0, 0, 0);
  } else if (period === "daily") {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  return start;
}

function getResetTime(period: QuotaPeriod, periodStart: Date): Date {
  const reset = new Date(periodStart);
  if (period === "hourly") {
    reset.setHours(reset.getHours() + 1);
  } else if (period === "daily") {
    reset.setDate(reset.getDate() + 1);
  } else {
    reset.setMonth(reset.getMonth() + 1);
  }
  return reset;
}

/** Interface for quota persistence (uses KV store) */
export interface QuotaStore {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

export class QuotaTracker {
  private definitions: Map<string, QuotaDefinition> = new Map();
  private store: QuotaStore | null;

  constructor(store: QuotaStore | null = null) {
    this.store = store;
  }

  /** Define a quota */
  define(def: QuotaDefinition): void {
    this.definitions.set(def.name, def);
    // Initialize from store if available and not already in current period
    if (this.store) {
      const key = this.storageKey(def.name);
      const raw = this.store.getKV(key);
      if (raw) {
        const stored = JSON.parse(raw) as { used: number; periodStart: string };
        const currentPeriodStart = getPeriodStart(def.period);
        if (new Date(stored.periodStart) < currentPeriodStart) {
          // Period expired, reset
          this.store.setKV(key, JSON.stringify({ used: 0, periodStart: currentPeriodStart.toISOString() }));
        }
      }
    }
  }

  private storageKey(name: string): string {
    return `quota:${name}`;
  }

  private getUsageData(name: string, period: QuotaPeriod): { used: number; periodStart: Date } {
    const currentPeriodStart = getPeriodStart(period);

    if (this.store) {
      const raw = this.store.getKV(this.storageKey(name));
      if (raw) {
        const stored = JSON.parse(raw) as { used: number; periodStart: string };
        const storedStart = new Date(stored.periodStart);
        if (storedStart >= currentPeriodStart) {
          return { used: stored.used, periodStart: storedStart };
        }
      }
    }

    return { used: 0, periodStart: currentPeriodStart };
  }

  private saveUsage(name: string, used: number, periodStart: Date): void {
    if (this.store) {
      this.store.setKV(this.storageKey(name), JSON.stringify({ used, periodStart: periodStart.toISOString() }));
    }
  }

  /** Increment usage and check quota. Returns check result. */
  increment(name: string, amount: number = 1): QuotaCheckResult {
    const def = this.definitions.get(name);
    if (!def) {
      return {
        allowed: true,
        usage: { name, used: 0, limit: Infinity, period: "daily", periodStart: new Date().toISOString(), resetAt: new Date().toISOString() },
      };
    }

    const { used, periodStart } = this.getUsageData(name, def.period);
    const resetAt = getResetTime(def.period, periodStart);
    const newUsed = used + amount;
    const warnThreshold = def.warnAt ?? 0.8;

    const usage: QuotaUsage = {
      name,
      used: newUsed,
      limit: def.limit,
      period: def.period,
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
    };

    if (newUsed > def.limit) {
      return {
        allowed: false,
        warning: `Quota exceeded: ${name} (${newUsed}/${def.limit} per ${def.period}). Resets at ${resetAt.toISOString()}.`,
        usage,
      };
    }

    // Save the incremented usage
    this.saveUsage(name, newUsed, periodStart);

    let warning: string | undefined;
    if (newUsed >= def.limit * warnThreshold) {
      warning = `Quota warning: ${name} at ${Math.round((newUsed / def.limit) * 100)}% (${newUsed}/${def.limit} per ${def.period}).`;
    }

    return { allowed: true, warning, usage };
  }

  /** Check quota without incrementing */
  check(name: string): QuotaCheckResult {
    const def = this.definitions.get(name);
    if (!def) {
      return {
        allowed: true,
        usage: { name, used: 0, limit: Infinity, period: "daily", periodStart: new Date().toISOString(), resetAt: new Date().toISOString() },
      };
    }

    const { used, periodStart } = this.getUsageData(name, def.period);
    const resetAt = getResetTime(def.period, periodStart);
    const warnThreshold = def.warnAt ?? 0.8;

    const usage: QuotaUsage = {
      name,
      used,
      limit: def.limit,
      period: def.period,
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
    };

    if (used >= def.limit) {
      return {
        allowed: false,
        warning: `Quota exceeded: ${name} (${used}/${def.limit} per ${def.period}).`,
        usage,
      };
    }

    let warning: string | undefined;
    if (used >= def.limit * warnThreshold) {
      warning = `Quota warning: ${name} at ${Math.round((used / def.limit) * 100)}% (${used}/${def.limit}).`;
    }

    return { allowed: true, warning, usage };
  }

  /** Get all quota statuses */
  getAllStatus(): QuotaUsage[] {
    const result: QuotaUsage[] = [];
    for (const def of this.definitions.values()) {
      const { used, periodStart } = this.getUsageData(def.name, def.period);
      const resetAt = getResetTime(def.period, periodStart);
      result.push({
        name: def.name,
        used,
        limit: def.limit,
        period: def.period,
        periodStart: periodStart.toISOString(),
        resetAt: resetAt.toISOString(),
      });
    }
    return result;
  }

  /** Reset a specific quota */
  resetQuota(name: string): void {
    const def = this.definitions.get(name);
    if (def) {
      this.saveUsage(name, 0, getPeriodStart(def.period));
    }
  }

  /** Get a definition */
  getDefinition(name: string): QuotaDefinition | undefined {
    return this.definitions.get(name);
  }
}
