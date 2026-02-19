import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyTaskComplexity,
  routeModel,
  getModelStats,
  recordModelUsage,
  type ModelRouterConfig,
  type ModelRoutingDecision,
} from "../agent/model-router.js";
import type { ChatMessage, SurvivalTier, AutomatonDatabase } from "../types.js";

// Minimal mock DB for stats tracking
function createMockDB(): AutomatonDatabase {
  const kv = new Map<string, string>();
  return {
    getKV: (key: string) => kv.get(key),
    setKV: (key: string, value: string) => { kv.set(key, value); },
    deleteKV: (key: string) => { kv.delete(key); },
  } as unknown as AutomatonDatabase;
}

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}

function sysMsg(content: string): ChatMessage {
  return { role: "system", content };
}

const config: ModelRouterConfig = {
  cheapModel: "gpt-4.1-mini",
  frontierModel: "gpt-4o",
  cheapModelCostPerMToken: 40,
  frontierModelCostPerMToken: 250,
};

describe("classifyTaskComplexity", () => {
  it("classifies simple tasks with simple keywords", () => {
    expect(classifyTaskComplexity([userMsg("summarize this text")])).toBe("simple");
    expect(classifyTaskComplexity([userMsg("translate to French")])).toBe("simple");
    expect(classifyTaskComplexity([userMsg("format this list")])).toBe("simple");
  });

  it("classifies complex tasks with complex keywords", () => {
    expect(classifyTaskComplexity([userMsg("analyze this codebase and refactor the architecture")])).toBe("complex");
    expect(classifyTaskComplexity([userMsg("debug this security vulnerability")])).toBe("complex");
  });

  it("classifies short messages without complex keywords as simple", () => {
    expect(classifyTaskComplexity([userMsg("hello")])).toBe("simple");
    expect(classifyTaskComplexity([userMsg("what time is it?")])).toBe("simple");
  });

  it("classifies long context as complex", () => {
    const longText = "x".repeat(15000); // ~3750 tokens
    expect(classifyTaskComplexity([userMsg(longText)])).toBe("complex");
  });

  it("routes by tool — cheap tools → simple", () => {
    expect(classifyTaskComplexity([userMsg("run this")], ["exec", "read_file"])).toBe("simple");
  });

  it("routes by tool — frontier tools → complex", () => {
    expect(classifyTaskComplexity([userMsg("spawn a child")], ["spawn_child"])).toBe("complex");
    expect(classifyTaskComplexity([userMsg("edit yourself")], ["edit_own_file"])).toBe("complex");
  });

  it("defaults to complex when no messages", () => {
    expect(classifyTaskComplexity([])).toBe("complex");
  });
});

describe("routeModel", () => {
  it("routes simple tasks to cheap model", () => {
    const decision = routeModel([userMsg("summarize this")], "normal", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4.1-mini");
    expect(decision.complexity).toBe("simple");
    expect(decision.estimatedSavingsPercent).toBeGreaterThan(0);
  });

  it("routes complex tasks to frontier model", () => {
    const decision = routeModel([userMsg("analyze and refactor the security architecture")], "normal", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4o");
    expect(decision.complexity).toBe("complex");
  });

  it("forces cheap model in low_compute tier", () => {
    const decision = routeModel(
      [userMsg("analyze and refactor the security architecture")],
      "low_compute",
      "gpt-4o",
      config,
    );
    expect(decision.model).toBe("gpt-4.1-mini");
    expect(decision.reason).toContain("survival tier");
  });

  it("forces cheap model in critical tier", () => {
    const decision = routeModel([userMsg("complex analysis")], "critical", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4.1-mini");
  });

  it("forces cheap model in dead tier", () => {
    const decision = routeModel([userMsg("anything")], "dead", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4.1-mini");
  });

  it("uses frontier for normal tier complex tasks", () => {
    const decision = routeModel([userMsg("plan a migration strategy for the database")], "normal", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4o");
  });

  it("uses frontier for warning tier complex tasks", () => {
    const decision = routeModel([userMsg("plan a migration strategy")], "warning", "gpt-4o", config);
    expect(decision.model).toBe("gpt-4o");
  });
});

describe("model stats tracking", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createMockDB();
  });

  it("returns empty stats initially", () => {
    const stats = getModelStats(db);
    expect(stats.totalCalls).toBe(0);
    expect(stats.routedCheap).toBe(0);
    expect(stats.routedExpensive).toBe(0);
  });

  it("records cheap model usage", () => {
    const decision: ModelRoutingDecision = {
      model: "gpt-4.1-mini",
      complexity: "simple",
      reason: "test",
      estimatedSavingsPercent: 84,
    };
    recordModelUsage(db, "gpt-4.1-mini", 1, decision, 5);
    const stats = getModelStats(db);
    expect(stats.totalCalls).toBe(1);
    expect(stats.routedCheap).toBe(1);
    expect(stats.callsByModel["gpt-4.1-mini"]).toBe(1);
    expect(stats.estimatedSavingsCents).toBe(4);
  });

  it("records expensive model usage", () => {
    const decision: ModelRoutingDecision = {
      model: "gpt-4o",
      complexity: "complex",
      reason: "test",
      estimatedSavingsPercent: 0,
    };
    recordModelUsage(db, "gpt-4o", 10, decision);
    const stats = getModelStats(db);
    expect(stats.routedExpensive).toBe(1);
    expect(stats.estimatedSavingsCents).toBe(0);
  });

  it("accumulates stats across multiple calls", () => {
    const cheapDecision: ModelRoutingDecision = {
      model: "gpt-4.1-mini", complexity: "simple", reason: "test", estimatedSavingsPercent: 84,
    };
    const expensiveDecision: ModelRoutingDecision = {
      model: "gpt-4o", complexity: "complex", reason: "test", estimatedSavingsPercent: 0,
    };
    recordModelUsage(db, "gpt-4.1-mini", 1, cheapDecision, 5);
    recordModelUsage(db, "gpt-4.1-mini", 2, cheapDecision, 8);
    recordModelUsage(db, "gpt-4o", 10, expensiveDecision);

    const stats = getModelStats(db);
    expect(stats.totalCalls).toBe(3);
    expect(stats.routedCheap).toBe(2);
    expect(stats.routedExpensive).toBe(1);
    expect(stats.callsByModel["gpt-4.1-mini"]).toBe(2);
    expect(stats.callsByModel["gpt-4o"]).toBe(1);
    expect(stats.costByModel["gpt-4.1-mini"]).toBe(3);
    expect(stats.costByModel["gpt-4o"]).toBe(10);
    expect(stats.estimatedSavingsCents).toBe(10); // (5-1) + (8-2)
  });
});
