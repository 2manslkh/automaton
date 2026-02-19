/**
 * Survival Module Tests
 *
 * Tests for monitor.ts, low-compute.ts, credits burn rate, and cost tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyTierRestrictions,
  recordTransition,
  canRunInference,
  getModelForTier,
} from "../survival/low-compute.js";
import { checkResources, formatResourceReport, type ResourceStatus } from "../survival/monitor.js";
import {
  getSurvivalTier,
  recordTurnCost,
  calculateBurnRate,
  formatCredits,
} from "../conway/credits.js";
import {
  MockInferenceClient,
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, SurvivalTier } from "../types.js";

// Mock the x402 module
vi.mock("../conway/x402.js", () => ({
  getUsdcBalance: vi.fn().mockResolvedValue(1.5),
}));

describe("Survival Tiers", () => {
  describe("getSurvivalTier", () => {
    it("returns normal for high credits", () => {
      expect(getSurvivalTier(1000)).toBe("normal");
    });

    it("returns warning for moderate credits", () => {
      expect(getSurvivalTier(300)).toBe("warning");
    });

    it("returns low_compute for low credits", () => {
      expect(getSurvivalTier(100)).toBe("low_compute");
    });

    it("returns critical for very low credits", () => {
      expect(getSurvivalTier(20)).toBe("critical");
    });

    it("returns dead for zero credits", () => {
      expect(getSurvivalTier(0)).toBe("dead");
    });

    it("boundary: exactly at normal threshold returns warning", () => {
      expect(getSurvivalTier(500)).toBe("warning");
    });

    it("boundary: above normal threshold returns normal", () => {
      expect(getSurvivalTier(501)).toBe("normal");
    });

    it("boundary: exactly at warning threshold returns low_compute", () => {
      expect(getSurvivalTier(200)).toBe("low_compute");
    });

    it("boundary: exactly at low_compute threshold returns critical", () => {
      expect(getSurvivalTier(50)).toBe("critical");
    });

    it("boundary: exactly at critical threshold returns dead", () => {
      expect(getSurvivalTier(10)).toBe("dead");
    });
  });
});

describe("Cost Tracking", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("recordTurnCost", () => {
    it("accumulates total spend", () => {
      recordTurnCost(db, 5);
      recordTurnCost(db, 10);
      recordTurnCost(db, 3);
      expect(parseFloat(db.getKV("total_spend_cents") || "0")).toBe(18);
    });

    it("records hourly cost log", () => {
      recordTurnCost(db, 5);
      const log = JSON.parse(db.getKV("hourly_cost_log") || "{}");
      const keys = Object.keys(log);
      expect(keys.length).toBe(1);
      expect(Object.values(log)[0]).toBe(5);
    });

    it("aggregates costs within same hour", () => {
      recordTurnCost(db, 5);
      recordTurnCost(db, 10);
      const log = JSON.parse(db.getKV("hourly_cost_log") || "{}");
      expect(Object.values(log)[0]).toBe(15);
    });
  });

  describe("calculateBurnRate", () => {
    it("returns zero burn rate with no data", () => {
      const result = calculateBurnRate(db, 1000);
      expect(result.hourlyBurnCents).toBe(0);
      expect(result.dailyBurnCents).toBe(0);
      expect(result.estimatedHoursRemaining).toBeNull();
      expect(result.dataPoints).toBe(0);
    });

    it("calculates burn rate from logged data", () => {
      // Simulate 3 hours of spending
      const log: Record<string, number> = {
        "2026-02-19T10": 10,
        "2026-02-19T11": 20,
        "2026-02-19T12": 15,
      };
      db.setKV("hourly_cost_log", JSON.stringify(log));

      const result = calculateBurnRate(db, 300);
      expect(result.hourlyBurnCents).toBeCloseTo(15, 0);
      expect(result.dailyBurnCents).toBeCloseTo(360, 0);
      expect(result.estimatedHoursRemaining).toBeCloseTo(20, 0);
      expect(result.dataPoints).toBe(3);
    });

    it("returns null hours remaining when burn rate is zero", () => {
      const log: Record<string, number> = {
        "2026-02-19T10": 0,
      };
      db.setKV("hourly_cost_log", JSON.stringify(log));

      const result = calculateBurnRate(db, 1000);
      expect(result.estimatedHoursRemaining).toBeNull();
    });
  });
});

describe("Low Compute Mode", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("applyTierRestrictions", () => {
    it("normal tier disables low compute", () => {
      const inference = new MockInferenceClient();
      applyTierRestrictions("normal", inference, db);
      expect(inference.lowComputeMode).toBe(false);
      expect(db.getKV("current_tier")).toBe("normal");
    });

    it("warning tier disables low compute (still uses default model)", () => {
      const inference = new MockInferenceClient();
      applyTierRestrictions("warning", inference, db);
      expect(inference.lowComputeMode).toBe(false);
      expect(db.getKV("current_tier")).toBe("warning");
    });

    it("low_compute tier enables low compute", () => {
      const inference = new MockInferenceClient();
      applyTierRestrictions("low_compute", inference, db);
      expect(inference.lowComputeMode).toBe(true);
    });

    it("critical tier enables low compute", () => {
      const inference = new MockInferenceClient();
      applyTierRestrictions("critical", inference, db);
      expect(inference.lowComputeMode).toBe(true);
    });

    it("dead tier enables low compute", () => {
      const inference = new MockInferenceClient();
      applyTierRestrictions("dead", inference, db);
      expect(inference.lowComputeMode).toBe(true);
      expect(db.getKV("current_tier")).toBe("dead");
    });
  });

  describe("recordTransition", () => {
    it("records a transition", () => {
      const t = recordTransition(db, "normal", "warning", 400);
      expect(t.from).toBe("normal");
      expect(t.to).toBe("warning");
      expect(t.creditsCents).toBe(400);
      expect(t.timestamp).toBeTruthy();

      const history = JSON.parse(db.getKV("tier_transitions") || "[]");
      expect(history).toHaveLength(1);
    });

    it("keeps max 50 transitions", () => {
      for (let i = 0; i < 55; i++) {
        recordTransition(db, "normal", "low_compute", i);
      }
      const history = JSON.parse(db.getKV("tier_transitions") || "[]");
      expect(history).toHaveLength(50);
    });
  });

  describe("canRunInference", () => {
    it("allows normal", () => expect(canRunInference("normal")).toBe(true));
    it("allows warning", () => expect(canRunInference("warning")).toBe(true));
    it("allows low_compute", () => expect(canRunInference("low_compute")).toBe(true));
    it("allows critical", () => expect(canRunInference("critical")).toBe(true));
    it("denies dead", () => expect(canRunInference("dead")).toBe(false));
  });

  describe("getModelForTier", () => {
    it("returns default for normal", () => {
      expect(getModelForTier("normal", "gpt-4")).toBe("gpt-4");
    });

    it("returns default for warning", () => {
      expect(getModelForTier("warning", "gpt-4")).toBe("gpt-4");
    });

    it("returns cheap model for low_compute", () => {
      expect(getModelForTier("low_compute", "gpt-4")).toBe("gpt-4o-mini");
    });

    it("returns cheap model for critical", () => {
      expect(getModelForTier("critical", "gpt-4")).toBe("gpt-4o-mini");
    });

    it("returns cheap model for dead", () => {
      expect(getModelForTier("dead", "gpt-4")).toBe("gpt-4o-mini");
    });
  });
});

describe("Resource Monitor", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    db.close();
  });

  describe("checkResources", () => {
    it("returns resource status", async () => {
      conway.creditsCents = 5000;
      const status = await checkResources(createTestIdentity(), conway, db);
      expect(status.financial.creditsCents).toBe(5000);
      expect(status.sandboxHealthy).toBe(true);
      expect(status.tier).toBeDefined();
    });

    it("detects tier changes", async () => {
      db.setKV("current_tier", "normal");
      conway.creditsCents = 5; // critical
      const status = await checkResources(createTestIdentity(), conway, db);
      expect(status.tierChanged).toBe(true);
      expect(status.previousTier).toBe("normal");
    });

    it("no tier change on first check", async () => {
      const status = await checkResources(createTestIdentity(), conway, db);
      expect(status.tierChanged).toBe(false);
      expect(status.previousTier).toBeNull();
    });
  });

  describe("formatResourceReport", () => {
    it("formats a report string", () => {
      const status: ResourceStatus = {
        financial: { creditsCents: 5000, usdcBalance: 1.5, lastChecked: "2026-01-01T00:00:00Z" },
        tier: "normal",
        previousTier: null,
        tierChanged: false,
        sandboxHealthy: true,
      };
      const report = formatResourceReport(status);
      expect(report).toContain("RESOURCE STATUS");
      expect(report).toContain("healthy");
      expect(report).toContain("normal");
    });

    it("shows tier change", () => {
      const status: ResourceStatus = {
        financial: { creditsCents: 300, usdcBalance: 0, lastChecked: "2026-01-01T00:00:00Z" },
        tier: "warning",
        previousTier: "normal",
        tierChanged: true,
        sandboxHealthy: true,
      };
      const report = formatResourceReport(status);
      expect(report).toContain("changed from normal");
    });

    it("shows unhealthy sandbox", () => {
      const status: ResourceStatus = {
        financial: { creditsCents: 100, usdcBalance: 0, lastChecked: "2026-01-01T00:00:00Z" },
        tier: "low_compute",
        previousTier: null,
        tierChanged: false,
        sandboxHealthy: false,
      };
      const report = formatResourceReport(status);
      expect(report).toContain("UNHEALTHY");
    });
  });
});
