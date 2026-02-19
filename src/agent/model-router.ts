/**
 * Model Router
 *
 * Intelligent routing: cheap models for simple tasks, frontier models for complex ones.
 * Respects survival tier overrides (low_compute/critical always use cheap).
 */

import type { SurvivalTier, ChatMessage, AutomatonDatabase } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────

export type TaskComplexity = "simple" | "complex";

export interface ModelRoutingDecision {
  model: string;
  complexity: TaskComplexity;
  reason: string;
  estimatedSavingsPercent: number;
}

export interface ModelStats {
  totalCalls: number;
  callsByModel: Record<string, number>;
  costByModel: Record<string, number>;
  routedCheap: number;
  routedExpensive: number;
  estimatedSavingsCents: number;
}

export interface ModelRouterConfig {
  cheapModel: string;
  frontierModel: string;
  cheapModelCostPerMToken: number;   // input cost per 1M tokens (cents)
  frontierModelCostPerMToken: number;
}

const DEFAULT_ROUTER_CONFIG: ModelRouterConfig = {
  cheapModel: "gpt-4.1-mini",
  frontierModel: "gpt-4o",
  cheapModelCostPerMToken: 40,
  frontierModelCostPerMToken: 250,
};

// ─── Heuristics ──────────────────────────────────────────────────

const SIMPLE_KEYWORDS = [
  "summarize", "summary", "format", "translate", "list", "convert",
  "rewrite", "rephrase", "extract", "count", "sort", "filter",
  "hello", "hi", "thanks", "status", "help", "describe",
];

const COMPLEX_KEYWORDS = [
  "reason", "analyze", "debug", "refactor", "architect", "design",
  "plan", "strategy", "optimize", "prove", "derive", "implement",
  "security", "vulnerability", "algorithm", "mathematical",
  "code review", "migration", "financial",
];

const CHEAP_TOOLS = new Set([
  "exec", "write_file", "read_file", "list_files", "sleep",
  "get_memory", "set_memory", "heartbeat_status",
]);

const FRONTIER_TOOLS = new Set([
  "spawn_child", "edit_own_file", "transfer_credits",
  "register_agent", "install_skill", "self_modify",
  "expose_port", "deploy_vm",
]);

// ─── Classification ──────────────────────────────────────────────

export function classifyTaskComplexity(
  messages: ChatMessage[],
  pendingTools?: string[],
): TaskComplexity {
  // Check tool-based routing first
  if (pendingTools && pendingTools.length > 0) {
    if (pendingTools.some(t => FRONTIER_TOOLS.has(t))) return "complex";
    if (pendingTools.every(t => CHEAP_TOOLS.has(t))) return "simple";
  }

  // Analyze the last user/system message content
  const lastContent = getLastRelevantContent(messages);
  if (!lastContent) return "complex"; // default to frontier if unclear

  const lower = lastContent.toLowerCase();
  const tokenEstimate = lastContent.length / 4; // rough char-to-token

  // Long context → likely complex
  if (tokenEstimate > 3000) return "complex";

  // Keyword matching
  const simpleScore = SIMPLE_KEYWORDS.filter(k => lower.includes(k)).length;
  const complexScore = COMPLEX_KEYWORDS.filter(k => lower.includes(k)).length;

  // Code/math indicators
  if (/```[\s\S]{200,}/.test(lastContent)) return "complex";
  if (/\b(function|class|import|async|await)\b/.test(lastContent) && tokenEstimate > 500) return "complex";

  if (complexScore > simpleScore) return "complex";
  if (simpleScore > 0 && complexScore === 0 && tokenEstimate < 1000) return "simple";

  // Short, simple messages
  if (tokenEstimate < 200 && complexScore === 0) return "simple";

  return "complex";
}

function getLastRelevantContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.role === "user" || msg.role === "system") && msg.content) {
      return msg.content;
    }
  }
  return undefined;
}

// ─── Router ──────────────────────────────────────────────────────

export function routeModel(
  messages: ChatMessage[],
  currentTier: SurvivalTier,
  defaultModel: string,
  config: ModelRouterConfig = DEFAULT_ROUTER_CONFIG,
  pendingTools?: string[],
): ModelRoutingDecision {
  // Tier overrides: low_compute/critical/dead always use cheap
  if (currentTier === "low_compute" || currentTier === "critical" || currentTier === "dead") {
    return {
      model: config.cheapModel,
      complexity: "simple",
      reason: `survival tier "${currentTier}" forces cheap model`,
      estimatedSavingsPercent: savingsPercent(config),
    };
  }

  const complexity = classifyTaskComplexity(messages, pendingTools);

  if (complexity === "simple") {
    return {
      model: config.cheapModel,
      complexity: "simple",
      reason: "task classified as simple",
      estimatedSavingsPercent: savingsPercent(config),
    };
  }

  return {
    model: config.frontierModel,
    complexity: "complex",
    reason: "task classified as complex",
    estimatedSavingsPercent: 0,
  };
}

function savingsPercent(config: ModelRouterConfig): number {
  if (config.frontierModelCostPerMToken === 0) return 0;
  return Math.round(
    (1 - config.cheapModelCostPerMToken / config.frontierModelCostPerMToken) * 100,
  );
}

// ─── Stats Tracking ──────────────────────────────────────────────

const STATS_KEY = "model_routing_stats";

export function getModelStats(db: AutomatonDatabase): ModelStats {
  const raw = db.getKV(STATS_KEY);
  if (!raw) {
    return {
      totalCalls: 0,
      callsByModel: {},
      costByModel: {},
      routedCheap: 0,
      routedExpensive: 0,
      estimatedSavingsCents: 0,
    };
  }
  return JSON.parse(raw) as ModelStats;
}

export function recordModelUsage(
  db: AutomatonDatabase,
  model: string,
  costCents: number,
  decision: ModelRoutingDecision,
  frontierCostCents?: number,
): void {
  const stats = getModelStats(db);
  stats.totalCalls++;
  stats.callsByModel[model] = (stats.callsByModel[model] || 0) + 1;
  stats.costByModel[model] = (stats.costByModel[model] || 0) + costCents;

  if (decision.complexity === "simple") {
    stats.routedCheap++;
    // Estimated savings = what frontier would have cost minus what cheap cost
    if (frontierCostCents !== undefined) {
      stats.estimatedSavingsCents += Math.max(0, frontierCostCents - costCents);
    }
  } else {
    stats.routedExpensive++;
  }

  db.setKV(STATS_KEY, JSON.stringify(stats));
}
