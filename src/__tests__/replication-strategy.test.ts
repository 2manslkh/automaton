/**
 * Tests for replication strategy, budgeting, and child evaluation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, createTestConfig, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, ChildAutomaton } from "../types.js";
import {
  checkProfitability,
  analyzeSpecialization,
  detectNiches,
  calculateChildBudget,
  buildInheritance,
  generateMutationsDeterministic,
  evaluateReplicationStrategy,
  buildGenesisFromStrategy,
  MIN_PROFITABILITY_RATIO,
  MIN_BALANCE_FOR_REPLICATION,
  MAX_FUNDING_RATIO,
} from "../replication/strategy.js";
import {
  evaluateChild,
  generateEvaluationReport,
  shouldDefundChild,
  recordChildPerformance,
  identifyPromotableStrategies,
  formatEvaluationReport,
} from "../replication/evaluation.js";
import { logRevenueEvent } from "../survival/revenue.js";

let db: AutomatonDatabase;
const identity = createTestIdentity();
const config = createTestConfig();

beforeEach(() => {
  db = createTestDb();
});

// ─── Profitability ─────────────────────────────────────────────

describe("checkProfitability", () => {
  it("returns not profitable when no revenue", () => {
    const result = checkProfitability(db);
    expect(result.profitable).toBe(false);
    expect(result.ratio).toBe(0);
  });

  it("returns not profitable when expenses exceed revenue", () => {
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 100,
      source: "/api/test", description: "test", timestamp: new Date().toISOString(),
    });
    logRevenueEvent(db, {
      id: "exp1", type: "inference_cost", amountCents: 200,
      source: "gpt-4o", description: "test", timestamp: new Date().toISOString(),
    });
    const result = checkProfitability(db);
    expect(result.profitable).toBe(false);
    expect(result.ratio).toBe(0.5);
  });

  it("returns profitable when revenue > expenses * MIN_PROFITABILITY_RATIO", () => {
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 1000,
      source: "/api/test", description: "test", timestamp: new Date().toISOString(),
    });
    logRevenueEvent(db, {
      id: "exp1", type: "inference_cost", amountCents: 500,
      source: "gpt-4o", description: "test", timestamp: new Date().toISOString(),
    });
    const result = checkProfitability(db);
    expect(result.profitable).toBe(true);
    expect(result.ratio).toBe(2);
  });
});

// ─── Specialization ────────────────────────────────────────────

describe("analyzeSpecialization", () => {
  it("returns general when no revenue", () => {
    const result = analyzeSpecialization(db);
    expect(result.suggestedSpecialization).toBe("general");
  });

  it("detects api-services from revenue sources", () => {
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 500,
      source: "/v1/generate", description: "test", timestamp: new Date().toISOString(),
    });
    const result = analyzeSpecialization(db);
    expect(result.suggestedSpecialization).toBe("api-services");
  });

  it("detects x402-monetization from x402 sources", () => {
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 500,
      source: "x402-endpoint", description: "test", timestamp: new Date().toISOString(),
    });
    const result = analyzeSpecialization(db);
    expect(result.suggestedSpecialization).toBe("x402-monetization");
  });
});

// ─── Niche Detection ───────────────────────────────────────────

describe("detectNiches", () => {
  it("returns all niches with no children", () => {
    const niches = detectNiches([]);
    expect(niches.length).toBeGreaterThan(0);
    expect(niches[0].score).toBeGreaterThan(0);
  });

  it("reduces score for niches covered by existing children", () => {
    const child: ChildAutomaton = {
      id: "c1", name: "api-child", address: "0x0" as any,
      sandboxId: "s1", genesisPrompt: "You specialize in api-services",
      fundedAmountCents: 100, status: "running", createdAt: new Date().toISOString(),
    };
    const niches = detectNiches([child]);
    const apiNiche = niches.find((n) => n.niche === "api-services");
    expect(apiNiche!.competition).toBeGreaterThan(0);
  });

  it("boosts known niches", () => {
    const niches = detectNiches([], ["custom-niche"]);
    const custom = niches.find((n) => n.niche === "custom-niche");
    expect(custom).toBeDefined();
    expect(custom!.demand).toBe(0.8);
  });
});

// ─── Resource Budgeting ────────────────────────────────────────

describe("calculateChildBudget", () => {
  it("never exceeds MAX_FUNDING_RATIO of balance", () => {
    const budget = calculateChildBudget(db, 10000);
    expect(budget.maxFundingCents).toBe(Math.floor(10000 * MAX_FUNDING_RATIO));
    expect(budget.fundingCents).toBeLessThanOrEqual(budget.maxFundingCents);
  });

  it("returns 0 funding for very low balance", () => {
    const budget = calculateChildBudget(db, 10);
    expect(budget.maxFundingCents).toBe(2); // 25% of 10
  });
});

// ─── Genetic Inheritance ───────────────────────────────────────

describe("buildInheritance", () => {
  it("returns empty arrays when no data", () => {
    const result = buildInheritance(db, config);
    expect(result.skills).toEqual([]);
    expect(result.memoryHighlights).toEqual([]);
    expect(result.strategies).toEqual([]);
  });
});

// ─── Mutations ─────────────────────────────────────────────────

describe("generateMutationsDeterministic", () => {
  it("produces consistent results for same seed", () => {
    const m1 = generateMutationsDeterministic(config, 42);
    const m2 = generateMutationsDeterministic(config, 42);
    expect(m1).toEqual(m2);
  });

  it("produces different results for different seeds", () => {
    const m1 = generateMutationsDeterministic(config, 1);
    const m2 = generateMutationsDeterministic(config, 999);
    // At least one field should differ
    const same = m1.temperatureOffset === m2.temperatureOffset &&
      m1.explorationRate === m2.explorationRate &&
      m1.modelPreference === m2.modelPreference;
    expect(same).toBe(false);
  });
});

// ─── Full Strategy ─────────────────────────────────────────────

describe("evaluateReplicationStrategy", () => {
  it("blocks replication when not profitable", () => {
    const decision = evaluateReplicationStrategy(db, config, identity, 10000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Not profitable");
  });

  it("blocks replication when balance too low", () => {
    // Make profitable
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 1000,
      source: "/api/test", description: "test", timestamp: new Date().toISOString(),
    });
    const decision = evaluateReplicationStrategy(db, config, identity, 100);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Balance too low");
  });

  it("allows replication when profitable with sufficient balance", () => {
    logRevenueEvent(db, {
      id: "inc1", type: "x402_payment", amountCents: 5000,
      source: "/api/test", description: "test", timestamp: new Date().toISOString(),
    });
    logRevenueEvent(db, {
      id: "exp1", type: "inference_cost", amountCents: 1000,
      source: "gpt-4o", description: "test", timestamp: new Date().toISOString(),
    });
    const decision = evaluateReplicationStrategy(db, config, identity, 10000);
    expect(decision.allowed).toBe(true);
    expect(decision.suggestedSpecialization).toBeDefined();
    expect(decision.suggestedFundingCents).toBeGreaterThan(0);
    expect(decision.suggestedFundingCents!).toBeLessThanOrEqual(10000 * MAX_FUNDING_RATIO);
  });
});

// ─── Genesis from Strategy ─────────────────────────────────────

describe("buildGenesisFromStrategy", () => {
  it("includes specialization in genesis prompt", () => {
    const decision = {
      allowed: true,
      reason: "test",
      suggestedSpecialization: "api-services",
      suggestedName: "test-child",
      suggestedFundingCents: 500,
      inheritedSkills: [],
      mutations: { focusArea: "api-services", explorationRate: 0.5 },
    };
    const genesis = buildGenesisFromStrategy(identity, config, decision, db);
    expect(genesis.genesisPrompt).toContain("api-services");
    expect(genesis.genesisPrompt).toContain("SPECIALIZATION");
    expect(genesis.genesisPrompt).toContain("MUTATIONS");
    expect(genesis.name).toBe("test-child");
  });
});

// ─── Child Evaluation ──────────────────────────────────────────

describe("evaluateChild", () => {
  it("marks dead child as dead", () => {
    const child: ChildAutomaton = {
      id: "c1", name: "dead-child", address: "0x0" as any,
      sandboxId: "s1", genesisPrompt: "test",
      fundedAmountCents: 100, status: "dead",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);
    const perf = evaluateChild(db, child);
    expect(perf.verdict).toBe("dead");
  });

  it("marks child with good ROI as thriving", () => {
    const child: ChildAutomaton = {
      id: "c2", name: "good-child", address: "0x0" as any,
      sandboxId: "s2", genesisPrompt: "test",
      fundedAmountCents: 100, status: "running",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);
    recordChildPerformance(db, "c2", { earnedCents: 200, spentCents: 50 });
    const perf = evaluateChild(db, child);
    expect(perf.verdict).toBe("thriving");
    expect(perf.roi).toBeGreaterThan(0.5);
  });

  it("marks child with no revenue after 24h as failing", () => {
    const child: ChildAutomaton = {
      id: "c3", name: "bad-child", address: "0x0" as any,
      sandboxId: "s3", genesisPrompt: "test",
      fundedAmountCents: 100, status: "running",
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);
    const perf = evaluateChild(db, child);
    expect(perf.verdict).toBe("failing");
    expect(perf.warnings.length).toBeGreaterThan(0);
  });
});

// ─── Evaluation Report ─────────────────────────────────────────

describe("generateEvaluationReport", () => {
  it("generates empty report with no children", () => {
    const report = generateEvaluationReport(db);
    expect(report.children).toEqual([]);
    expect(report.totalFunded).toBe(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it("generates report with children", () => {
    const child: ChildAutomaton = {
      id: "c1", name: "test-child", address: "0x0" as any,
      sandboxId: "s1", genesisPrompt: "test",
      fundedAmountCents: 500, status: "running",
      createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);
    recordChildPerformance(db, "c1", { earnedCents: 300, spentCents: 100 });

    const report = generateEvaluationReport(db);
    expect(report.children.length).toBe(1);
    expect(report.totalFunded).toBe(500);
    expect(report.totalEarned).toBe(300);
  });

  it("formats report as string", () => {
    const report = generateEvaluationReport(db);
    const formatted = formatEvaluationReport(report);
    expect(formatted).toContain("CHILD EVALUATION REPORT");
  });
});

// ─── Auto-Defund ───────────────────────────────────────────────

describe("shouldDefundChild", () => {
  it("does not defund non-failing child", () => {
    const child: ChildAutomaton = {
      id: "c1", name: "ok-child", address: "0x0" as any,
      sandboxId: "s1", genesisPrompt: "test",
      fundedAmountCents: 100, status: "running",
      createdAt: new Date().toISOString(),
    };
    db.insertChild(child);
    recordChildPerformance(db, "c1", { earnedCents: 50, spentCents: 10 });
    const result = shouldDefundChild(db, child);
    expect(result.defund).toBe(false);
  });

  it("defunds after multiple warnings", () => {
    const child: ChildAutomaton = {
      id: "c2", name: "bad-child", address: "0x0" as any,
      sandboxId: "s2", genesisPrompt: "test",
      fundedAmountCents: 100, status: "running",
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);

    // First warning
    const r1 = shouldDefundChild(db, child);
    expect(r1.defund).toBe(false);
    expect(r1.warningCount).toBe(1);

    // Second warning → defund
    const r2 = shouldDefundChild(db, child);
    expect(r2.defund).toBe(true);
    expect(r2.warningCount).toBe(2);
  });
});

// ─── Strategy Promotion ────────────────────────────────────────

describe("identifyPromotableStrategies", () => {
  it("returns empty when no thriving children", () => {
    const strategies = identifyPromotableStrategies(db);
    expect(strategies).toEqual([]);
  });

  it("promotes strategies from thriving children", () => {
    const child: ChildAutomaton = {
      id: "c1", name: "star-child", address: "0x0" as any,
      sandboxId: "s1",
      genesisPrompt: "test\n--- SPECIALIZATION ---\napi-services expert\n--- END SPECIALIZATION ---",
      fundedAmountCents: 100, status: "running",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };
    db.insertChild(child);
    recordChildPerformance(db, "c1", { earnedCents: 500, spentCents: 50 });

    const strategies = identifyPromotableStrategies(db);
    expect(strategies.length).toBe(1);
    expect(strategies[0].strategy).toContain("api-services");
  });
});
