/**
 * Quota Manager
 *
 * Manages quotas for inference calls, tool execution, API requests,
 * and x402 spending. Adapts limits based on survival tier.
 */

import type { SurvivalTier } from "../types.js";
import {
  QuotaTracker,
  RateLimiterRegistry,
  type QuotaStore,
  type QuotaUsage,
  type QuotaCheckResult,
} from "./rate-limiter.js";

// ─── Quota Names ───────────────────────────────────────────────

export const QUOTA_INFERENCE_CALLS = "inference_calls_daily";
export const QUOTA_TOOL_CALLS = "tool_calls_hourly";
export const QUOTA_API_REQUESTS = "api_requests_daily";
export const QUOTA_X402_SPEND = "x402_spend_daily";

// ─── Rate Limit Keys ───────────────────────────────────────────

export const RATE_LIMIT_WEB_FETCH = "web_fetch";
export const RATE_LIMIT_WEB_SEARCH = "web_search";
export const RATE_LIMIT_WEBHOOK = "webhook";
export const RATE_LIMIT_TOOL_EXEC = "tool_exec";

// ─── Tier-Based Limits ─────────────────────────────────────────

export interface TierLimits {
  inferenceCallsPerDay: number;
  toolCallsPerHour: number;
  apiRequestsPerDay: number;
  x402SpendCentsPerDay: number;
  webFetchPerMinute: number;
  webSearchPerMinute: number;
  webhookPerMinute: number;
}

const TIER_LIMITS: Record<string, TierLimits> = {
  normal: {
    inferenceCallsPerDay: 500,
    toolCallsPerHour: 200,
    apiRequestsPerDay: 1000,
    x402SpendCentsPerDay: 5000, // $50
    webFetchPerMinute: 20,
    webSearchPerMinute: 15,
    webhookPerMinute: 120,
  },
  warning: {
    inferenceCallsPerDay: 300,
    toolCallsPerHour: 150,
    apiRequestsPerDay: 600,
    x402SpendCentsPerDay: 2000,
    webFetchPerMinute: 15,
    webSearchPerMinute: 10,
    webhookPerMinute: 90,
  },
  low_compute: {
    inferenceCallsPerDay: 100,
    toolCallsPerHour: 60,
    apiRequestsPerDay: 200,
    x402SpendCentsPerDay: 500,
    webFetchPerMinute: 5,
    webSearchPerMinute: 5,
    webhookPerMinute: 30,
  },
  critical: {
    inferenceCallsPerDay: 30,
    toolCallsPerHour: 20,
    apiRequestsPerDay: 50,
    x402SpendCentsPerDay: 100,
    webFetchPerMinute: 2,
    webSearchPerMinute: 2,
    webhookPerMinute: 10,
  },
  dead: {
    inferenceCallsPerDay: 0,
    toolCallsPerHour: 0,
    apiRequestsPerDay: 0,
    x402SpendCentsPerDay: 0,
    webFetchPerMinute: 0,
    webSearchPerMinute: 0,
    webhookPerMinute: 0,
  },
};

export function getTierLimits(tier: SurvivalTier): TierLimits {
  return TIER_LIMITS[tier] || TIER_LIMITS.normal!;
}

// ─── Quota Manager ─────────────────────────────────────────────

export class QuotaManager {
  readonly quotas: QuotaTracker;
  readonly rateLimiters: RateLimiterRegistry;
  private currentTier: SurvivalTier = "normal";

  constructor(store: QuotaStore | null = null) {
    this.quotas = new QuotaTracker(store);
    this.rateLimiters = new RateLimiterRegistry();
    this.applyTier("normal");
  }

  /** Update limits based on survival tier */
  applyTier(tier: SurvivalTier): void {
    this.currentTier = tier;
    const limits = getTierLimits(tier);

    // Define quotas
    this.quotas.define({ name: QUOTA_INFERENCE_CALLS, period: "daily", limit: limits.inferenceCallsPerDay });
    this.quotas.define({ name: QUOTA_TOOL_CALLS, period: "hourly", limit: limits.toolCallsPerHour });
    this.quotas.define({ name: QUOTA_API_REQUESTS, period: "daily", limit: limits.apiRequestsPerDay });
    this.quotas.define({ name: QUOTA_X402_SPEND, period: "daily", limit: limits.x402SpendCentsPerDay });

    // Register rate limiters
    this.rateLimiters.register(RATE_LIMIT_WEB_FETCH, {
      type: "sliding_window",
      windowMs: 60_000,
      maxRequests: limits.webFetchPerMinute,
    });
    this.rateLimiters.register(RATE_LIMIT_WEB_SEARCH, {
      type: "sliding_window",
      windowMs: 60_000,
      maxRequests: limits.webSearchPerMinute,
    });
    this.rateLimiters.register(RATE_LIMIT_WEBHOOK, {
      type: "token_bucket",
      maxTokens: limits.webhookPerMinute,
      refillRate: limits.webhookPerMinute / 60,
    });
    this.rateLimiters.register(RATE_LIMIT_TOOL_EXEC, {
      type: "sliding_window",
      windowMs: 60_000,
      maxRequests: 30, // general per-tool per-minute
    });
  }

  getCurrentTier(): SurvivalTier {
    return this.currentTier;
  }

  // ── Convenience: Check & Track ──

  /** Check and track an inference call */
  trackInferenceCall(): QuotaCheckResult {
    return this.quotas.increment(QUOTA_INFERENCE_CALLS);
  }

  /** Check and track a tool call */
  trackToolCall(toolName: string): QuotaCheckResult & { rateLimited?: string } {
    const rlResult = this.rateLimiters.check(RATE_LIMIT_TOOL_EXEC, toolName);
    if (rlResult) {
      const usage = this.quotas.check(QUOTA_TOOL_CALLS).usage;
      return { allowed: false, warning: rlResult, rateLimited: rlResult, usage };
    }
    return this.quotas.increment(QUOTA_TOOL_CALLS);
  }

  /** Check and track a web fetch */
  checkWebFetch(): string | null {
    const rlResult = this.rateLimiters.check(RATE_LIMIT_WEB_FETCH);
    if (rlResult) return rlResult;

    const quotaResult = this.quotas.increment(QUOTA_API_REQUESTS);
    if (!quotaResult.allowed) return quotaResult.warning || "API quota exceeded";
    return null;
  }

  /** Check and track a web search */
  checkWebSearch(): string | null {
    const rlResult = this.rateLimiters.check(RATE_LIMIT_WEB_SEARCH);
    if (rlResult) return rlResult;

    const quotaResult = this.quotas.increment(QUOTA_API_REQUESTS);
    if (!quotaResult.allowed) return quotaResult.warning || "API quota exceeded";
    return null;
  }

  /** Check webhook rate limit */
  checkWebhook(path: string): boolean {
    const result = this.rateLimiters.check(RATE_LIMIT_WEBHOOK, path);
    return result === null;
  }

  /** Track x402 spending */
  trackX402Spend(amountCents: number): QuotaCheckResult {
    return this.quotas.increment(QUOTA_X402_SPEND, amountCents);
  }

  /** Get full status report */
  getStatus(): {
    tier: SurvivalTier;
    quotas: QuotaUsage[];
    limits: TierLimits;
  } {
    return {
      tier: this.currentTier,
      quotas: this.quotas.getAllStatus(),
      limits: getTierLimits(this.currentTier),
    };
  }

  /** Format status as human-readable string */
  formatStatus(): string {
    const status = this.getStatus();
    const lines = [
      `=== QUOTA STATUS ===`,
      `Survival Tier: ${status.tier}`,
      ``,
    ];

    for (const q of status.quotas) {
      const pct = q.limit > 0 ? Math.round((q.used / q.limit) * 100) : 0;
      const bar = pct >= 100 ? "🔴" : pct >= 80 ? "🟡" : "🟢";
      lines.push(`${bar} ${q.name}: ${q.used}/${q.limit} (${pct}%) [${q.period}] resets ${q.resetAt}`);
    }

    lines.push(`========================`);
    return lines.join("\n");
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _quotaManager: QuotaManager | undefined;

export function getQuotaManager(store?: QuotaStore): QuotaManager {
  if (!_quotaManager) {
    _quotaManager = new QuotaManager(store || null);
  }
  return _quotaManager;
}

export function resetQuotaManager(): void {
  _quotaManager = undefined;
}
