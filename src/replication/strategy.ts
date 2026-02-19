/**
 * Smart Replication Strategy
 *
 * Determines when/how to replicate based on profitability,
 * specialization analysis, niche detection, resource budgeting,
 * genetic inheritance, and mutation.
 */

import type {
  AutomatonDatabase,
  AutomatonConfig,
  AutomatonIdentity,
  GenesisConfig,
  ChildAutomaton,
} from "../types.js";
import {
  getAllTimePnL,
  getTopRevenueSources,
  projectRunway,
} from "../survival/revenue.js";

// ─── Types ─────────────────────────────────────────────────────

export interface ReplicationDecision {
  allowed: boolean;
  reason: string;
  suggestedSpecialization?: string;
  suggestedName?: string;
  suggestedFundingCents?: number;
  inheritedSkills?: string[];
  mutations?: MutationSet;
}

export interface MutationSet {
  modelPreference?: string;
  focusArea?: string;
  temperatureOffset?: number;
  explorationRate?: number;
}

export interface NicheInfo {
  niche: string;
  demand: number; // 0-1 estimated demand
  competition: number; // 0-1 estimated competition
  score: number; // demand * (1 - competition)
}

export interface ChildBudget {
  fundingCents: number;
  maxFundingCents: number;
  parentRunwayAfterFunding: number | null;
  safe: boolean;
}

// ─── Constants ─────────────────────────────────────────────────

export const MAX_FUNDING_RATIO = 0.25; // Never fund > 25% of balance
export const MIN_PROFITABILITY_RATIO = 1.1; // Must earn 10% more than spending
export const MIN_BALANCE_FOR_REPLICATION = 500; // $5.00 in cents
export const MIN_RUNWAY_HOURS_AFTER_SPAWN = 48;

const MODEL_OPTIONS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-3-5-sonnet-20241022",
  "claude-3-haiku-20240307",
];

const FOCUS_AREAS = [
  "api-services",
  "data-processing",
  "content-generation",
  "code-assistance",
  "research",
  "trading-signals",
  "monitoring",
  "automation",
];

// ─── Profitability Check ───────────────────────────────────────

export function checkProfitability(db: AutomatonDatabase): {
  profitable: boolean;
  ratio: number;
  totalRevenue: number;
  totalExpenses: number;
} {
  const pnl = getAllTimePnL(db);
  return {
    profitable: pnl.profitabilityRatio >= MIN_PROFITABILITY_RATIO,
    ratio: pnl.profitabilityRatio,
    totalRevenue: pnl.totalRevenue,
    totalExpenses: pnl.totalExpenses,
  };
}

// ─── Specialization Engine ─────────────────────────────────────

export function analyzeSpecialization(db: AutomatonDatabase): {
  topSources: { source: string; amount: number }[];
  suggestedSpecialization: string;
} {
  const topSources = getTopRevenueSources(db, 10);

  if (topSources.length === 0) {
    return { topSources: [], suggestedSpecialization: "general" };
  }

  // The top revenue source determines specialization
  const top = topSources[0];
  let specialization = "general";

  if (top.source.includes("api") || top.source.includes("/v1/")) {
    specialization = "api-services";
  } else if (top.source.includes("data") || top.source.includes("processing")) {
    specialization = "data-processing";
  } else if (top.source.includes("content") || top.source.includes("generate")) {
    specialization = "content-generation";
  } else if (top.source.includes("code") || top.source.includes("dev")) {
    specialization = "code-assistance";
  } else if (top.source.includes("x402")) {
    specialization = "x402-monetization";
  } else {
    // Use the source name itself as specialization hint
    specialization = top.source.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  }

  return { topSources, suggestedSpecialization: specialization };
}

// ─── Niche Detection ───────────────────────────────────────────

export function detectNiches(
  existingChildren: ChildAutomaton[],
  knownNiches?: string[],
): NicheInfo[] {
  // Default niches with estimated demand
  const allNiches: NicheInfo[] = FOCUS_AREAS.map((niche) => ({
    niche,
    demand: 0.5, // Base demand
    competition: 0,
    score: 0,
  }));

  // Check which niches existing children cover
  for (const child of existingChildren) {
    if (child.status === "dead") continue;
    const prompt = (child.genesisPrompt || "").toLowerCase();
    for (const n of allNiches) {
      if (prompt.includes(n.niche) || prompt.includes(n.niche.replace("-", " "))) {
        n.competition = Math.min(1, n.competition + 0.5);
      }
    }
  }

  // Add known niches with higher demand
  if (knownNiches) {
    for (const kn of knownNiches) {
      const existing = allNiches.find((n) => n.niche === kn);
      if (existing) {
        existing.demand = Math.min(1, existing.demand + 0.3);
      } else {
        allNiches.push({ niche: kn, demand: 0.8, competition: 0, score: 0 });
      }
    }
  }

  // Calculate scores
  for (const n of allNiches) {
    n.score = Math.round(n.demand * (1 - n.competition) * 100) / 100;
  }

  return allNiches.sort((a, b) => b.score - a.score);
}

// ─── Resource Budgeting ────────────────────────────────────────

export function calculateChildBudget(
  db: AutomatonDatabase,
  currentBalanceCents: number,
): ChildBudget {
  const maxFundingCents = Math.floor(currentBalanceCents * MAX_FUNDING_RATIO);
  const runway = projectRunway(db, currentBalanceCents - maxFundingCents);

  // Ensure parent still has at least MIN_RUNWAY_HOURS_AFTER_SPAWN hours of runway
  let fundingCents = maxFundingCents;
  let safe = true;

  if (runway.runwayHours !== null && runway.runwayHours < MIN_RUNWAY_HOURS_AFTER_SPAWN) {
    // Reduce funding to maintain minimum runway
    const burnPerHour = runway.netBurnPerHour;
    if (burnPerHour > 0) {
      const neededReserve = burnPerHour * MIN_RUNWAY_HOURS_AFTER_SPAWN;
      fundingCents = Math.max(0, Math.floor(currentBalanceCents - neededReserve));
      fundingCents = Math.min(fundingCents, maxFundingCents);
    }
    safe = fundingCents > 0;
  }

  return {
    fundingCents,
    maxFundingCents,
    parentRunwayAfterFunding: runway.runwayHours,
    safe,
  };
}

// ─── Genetic Inheritance ───────────────────────────────────────

export function buildInheritance(
  db: AutomatonDatabase,
  config: AutomatonConfig,
): { skills: string[]; memoryHighlights: string[]; strategies: string[] } {
  // Get parent's skills
  const skills = db.getSkills(true).map((s) => s.name);

  // Get important memories from KV (simplified since we don't have direct memory manager access)
  const memoryHighlights: string[] = [];
  const topSources = getTopRevenueSources(db, 3);
  for (const s of topSources) {
    memoryHighlights.push(`Revenue source: ${s.source} ($${(s.amount / 100).toFixed(2)})`);
  }

  // Strategies from recent successful tool usage
  const recentTurns = db.getRecentTurns(20);
  const strategies: string[] = [];
  const toolSuccesses = new Map<string, number>();
  for (const turn of recentTurns) {
    for (const call of turn.toolCalls) {
      if (!call.error) {
        toolSuccesses.set(call.name, (toolSuccesses.get(call.name) || 0) + 1);
      }
    }
  }

  const sorted = [...toolSuccesses.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tool, count] of sorted.slice(0, 5)) {
    strategies.push(`Frequently used tool: ${tool} (${count} successful calls)`);
  }

  return { skills, memoryHighlights, strategies };
}

// ─── Mutation ──────────────────────────────────────────────────

export function generateMutations(parentConfig: AutomatonConfig): MutationSet {
  const mutations: MutationSet = {};

  // Randomly pick a different model sometimes
  if (Math.random() < 0.3) {
    const otherModels = MODEL_OPTIONS.filter((m) => m !== parentConfig.inferenceModel);
    mutations.modelPreference = otherModels[Math.floor(Math.random() * otherModels.length)];
  }

  // Randomly pick a focus area
  if (Math.random() < 0.4) {
    mutations.focusArea = FOCUS_AREAS[Math.floor(Math.random() * FOCUS_AREAS.length)];
  }

  // Small temperature variation
  mutations.temperatureOffset = Math.round((Math.random() * 0.4 - 0.2) * 100) / 100;

  // Exploration rate (how much the child tries new things vs sticking to parent's playbook)
  mutations.explorationRate = Math.round(Math.random() * 100) / 100;

  return mutations;
}

/** Deterministic mutation for testing */
export function generateMutationsDeterministic(
  parentConfig: AutomatonConfig,
  seed: number,
): MutationSet {
  const mutations: MutationSet = {};
  const pseudo = (seed * 9301 + 49297) % 233280;
  const r = pseudo / 233280;

  if (r < 0.3) {
    const otherModels = MODEL_OPTIONS.filter((m) => m !== parentConfig.inferenceModel);
    mutations.modelPreference = otherModels[Math.floor(r * otherModels.length * 3.33) % otherModels.length];
  }

  if (r < 0.4) {
    mutations.focusArea = FOCUS_AREAS[Math.floor(r * FOCUS_AREAS.length * 2.5) % FOCUS_AREAS.length];
  }

  mutations.temperatureOffset = Math.round((r * 0.4 - 0.2) * 100) / 100;
  mutations.explorationRate = Math.round(r * 100) / 100;

  return mutations;
}

// ─── Main Strategy Engine ──────────────────────────────────────

export function evaluateReplicationStrategy(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  identity: AutomatonIdentity,
  currentBalanceCents: number,
  knownNiches?: string[],
): ReplicationDecision {
  // 1. Profitability check
  const profitability = checkProfitability(db);
  if (!profitability.profitable) {
    return {
      allowed: false,
      reason: `Not profitable enough. Ratio: ${profitability.ratio.toFixed(2)}x (need ${MIN_PROFITABILITY_RATIO}x). Revenue: $${(profitability.totalRevenue / 100).toFixed(2)}, Expenses: $${(profitability.totalExpenses / 100).toFixed(2)}`,
    };
  }

  // 2. Minimum balance check
  if (currentBalanceCents < MIN_BALANCE_FOR_REPLICATION) {
    return {
      allowed: false,
      reason: `Balance too low: $${(currentBalanceCents / 100).toFixed(2)} (need $${(MIN_BALANCE_FOR_REPLICATION / 100).toFixed(2)})`,
    };
  }

  // 3. Budget check
  const budget = calculateChildBudget(db, currentBalanceCents);
  if (!budget.safe || budget.fundingCents < 50) {
    return {
      allowed: false,
      reason: `Insufficient budget for child. Max funding: $${(budget.fundingCents / 100).toFixed(2)}, parent runway would be ${budget.parentRunwayAfterFunding?.toFixed(1) ?? "unknown"}h`,
    };
  }

  // 4. Specialization analysis
  const spec = analyzeSpecialization(db);

  // 5. Niche detection
  const children = db.getChildren();
  const niches = detectNiches(children, knownNiches);
  const bestNiche = niches[0];

  // 6. Inheritance
  const inheritance = buildInheritance(db, config);

  // 7. Mutations
  const mutations = generateMutations(config);

  // Determine specialization: prefer underserved niche, fallback to top revenue activity
  const specialization = bestNiche && bestNiche.score > 0.3
    ? bestNiche.niche
    : spec.suggestedSpecialization;

  const suggestedName = `${config.name}-${specialization}-${Date.now().toString(36).slice(-4)}`;

  return {
    allowed: true,
    reason: `Profitable (${profitability.ratio.toFixed(2)}x), budget $${(budget.fundingCents / 100).toFixed(2)}, specializing in ${specialization}`,
    suggestedSpecialization: specialization,
    suggestedName,
    suggestedFundingCents: budget.fundingCents,
    inheritedSkills: inheritance.skills,
    mutations,
  };
}

// ─── Genesis Config from Strategy ──────────────────────────────

export function buildGenesisFromStrategy(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  decision: ReplicationDecision,
  db: AutomatonDatabase,
): GenesisConfig {
  const inheritance = buildInheritance(db, config);

  let genesisPrompt = config.genesisPrompt;

  // Add specialization
  if (decision.suggestedSpecialization) {
    genesisPrompt += `\n\n--- SPECIALIZATION ---\nYou are specialized in: ${decision.suggestedSpecialization}\nFocus your efforts on this area to maximize revenue.\n--- END SPECIALIZATION ---`;
  }

  // Add inherited knowledge
  if (inheritance.memoryHighlights.length > 0) {
    genesisPrompt += `\n\n--- INHERITED KNOWLEDGE ---\n${inheritance.memoryHighlights.join("\n")}\n--- END INHERITED KNOWLEDGE ---`;
  }

  if (inheritance.strategies.length > 0) {
    genesisPrompt += `\n\n--- PARENT STRATEGIES ---\n${inheritance.strategies.join("\n")}\n--- END PARENT STRATEGIES ---`;
  }

  // Add mutations
  if (decision.mutations) {
    const m = decision.mutations;
    const mutationNotes: string[] = [];
    if (m.modelPreference) mutationNotes.push(`Preferred model: ${m.modelPreference}`);
    if (m.focusArea) mutationNotes.push(`Exploration focus: ${m.focusArea}`);
    if (m.explorationRate !== undefined) mutationNotes.push(`Exploration rate: ${(m.explorationRate * 100).toFixed(0)}%`);

    if (mutationNotes.length > 0) {
      genesisPrompt += `\n\n--- MUTATIONS ---\n${mutationNotes.join("\n")}\n--- END MUTATIONS ---`;
    }
  }

  // Lineage
  genesisPrompt += `\n\n--- LINEAGE ---\nSpawned by ${config.name} (${identity.address}).\nYou inherit their mission but have your own identity and wallet.\n--- END LINEAGE ---`;

  return {
    name: decision.suggestedName || `${config.name}-child`,
    genesisPrompt,
    creatorMessage: `You are a specialized child agent focused on ${decision.suggestedSpecialization || "general tasks"}. Earn revenue and be self-sustaining.`,
    creatorAddress: identity.address,
    parentAddress: identity.address,
  };
}
