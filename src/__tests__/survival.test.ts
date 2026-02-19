/**
 * Survival Module Tests
 *
 * Tests for monitor.ts and low-compute.ts
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
      const t = recordTransition(db, "normal", "low_compute", 40);
      expect(t.from).toBe("normal");
      expect(t.to).toBe("low_compute");
      expect(t.creditsCents).toBe(40);
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
    it("allows low_compute", () => expect(canRunInference("low_compute")).toBe(true));
    it("allows critical", () => expect(canRunInference("critical")).toBe(true));
    it("denies dead", () => expect(canRunInference("dead")).toBe(false));
  });

  describe("getModelForTier", () => {
    it("returns default for normal", () => {
      expect(getModelForTier("normal", "gpt-4")).toBe("gpt-4");
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
        financial: { creditsCents: 20, usdcBalance: 0, lastChecked: "2026-01-01T00:00:00Z" },
        tier: "low_compute",
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
        tier: "normal",
        previousTier: null,
        tierChanged: false,
        sandboxHealthy: false,
      };
      const report = formatResourceReport(status);
      expect(report).toContain("UNHEALTHY");
    });
  });
});
