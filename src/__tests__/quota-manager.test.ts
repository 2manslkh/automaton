import { describe, it, expect, beforeEach } from "vitest";
import {
  QuotaManager,
  getTierLimits,
  QUOTA_INFERENCE_CALLS,
  QUOTA_TOOL_CALLS,
  QUOTA_API_REQUESTS,
  QUOTA_X402_SPEND,
} from "../utils/quota-manager.js";

describe("QuotaManager", () => {
  let store: Map<string, string>;
  let kvStore: { getKV: (k: string) => string | undefined; setKV: (k: string, v: string) => void };
  let qm: QuotaManager;

  beforeEach(() => {
    store = new Map();
    kvStore = {
      getKV: (k: string) => store.get(k),
      setKV: (k: string, v: string) => store.set(k, v),
    };
    qm = new QuotaManager(kvStore);
  });

  describe("tier-based limits", () => {
    it("normal tier has highest limits", () => {
      const normal = getTierLimits("normal");
      const low = getTierLimits("low_compute");
      expect(normal.inferenceCallsPerDay).toBeGreaterThan(low.inferenceCallsPerDay);
      expect(normal.toolCallsPerHour).toBeGreaterThan(low.toolCallsPerHour);
    });

    it("dead tier has zero limits", () => {
      const dead = getTierLimits("dead");
      expect(dead.inferenceCallsPerDay).toBe(0);
      expect(dead.toolCallsPerHour).toBe(0);
    });

    it("applyTier changes limits", () => {
      qm.applyTier("normal");
      expect(qm.getCurrentTier()).toBe("normal");

      qm.applyTier("low_compute");
      expect(qm.getCurrentTier()).toBe("low_compute");

      // Verify inference quota limit changed
      const def = qm.quotas.getDefinition(QUOTA_INFERENCE_CALLS);
      expect(def!.limit).toBe(getTierLimits("low_compute").inferenceCallsPerDay);
    });
  });

  describe("trackInferenceCall", () => {
    it("allows within quota", () => {
      const result = qm.trackInferenceCall();
      expect(result.allowed).toBe(true);
    });

    it("blocks when quota exceeded", () => {
      qm.applyTier("critical"); // 30 calls/day
      for (let i = 0; i < 30; i++) qm.trackInferenceCall();
      const result = qm.trackInferenceCall();
      expect(result.allowed).toBe(false);
    });
  });

  describe("trackToolCall", () => {
    it("allows within quota", () => {
      const result = qm.trackToolCall("exec");
      expect(result.allowed).toBe(true);
    });

    it("tracks per-tool rate limits", () => {
      // Exhaust the per-tool per-minute sliding window (30/min)
      for (let i = 0; i < 30; i++) qm.trackToolCall("exec");
      const result = qm.trackToolCall("exec");
      expect(result.allowed).toBe(false);
    });
  });

  describe("checkWebFetch", () => {
    it("allows within limit", () => {
      expect(qm.checkWebFetch()).toBeNull();
    });

    it("blocks when rate limited", () => {
      const limit = getTierLimits("normal").webFetchPerMinute;
      for (let i = 0; i < limit; i++) qm.checkWebFetch();
      expect(qm.checkWebFetch()).not.toBeNull();
    });
  });

  describe("checkWebSearch", () => {
    it("allows within limit", () => {
      expect(qm.checkWebSearch()).toBeNull();
    });
  });

  describe("checkWebhook", () => {
    it("allows within limit", () => {
      expect(qm.checkWebhook("/hook1")).toBe(true);
    });
  });

  describe("trackX402Spend", () => {
    it("allows within daily spend limit", () => {
      const result = qm.trackX402Spend(100);
      expect(result.allowed).toBe(true);
    });

    it("blocks when daily spend exceeded", () => {
      qm.applyTier("critical"); // 100 cents/day
      qm.trackX402Spend(100);
      const result = qm.trackX402Spend(50);
      expect(result.allowed).toBe(false);
    });
  });

  describe("getStatus / formatStatus", () => {
    it("returns status with all quotas", () => {
      const status = qm.getStatus();
      expect(status.tier).toBe("normal");
      expect(status.quotas.length).toBeGreaterThanOrEqual(4);
    });

    it("formatStatus produces readable string", () => {
      qm.trackInferenceCall();
      qm.trackToolCall("test");
      const formatted = qm.formatStatus();
      expect(formatted).toContain("QUOTA STATUS");
      expect(formatted).toContain("Survival Tier: normal");
      expect(formatted).toContain(QUOTA_INFERENCE_CALLS);
    });
  });

  describe("persistence", () => {
    it("survives recreation with same store", () => {
      qm.trackInferenceCall();
      qm.trackInferenceCall();
      qm.trackInferenceCall();

      // Create new manager with same store
      const qm2 = new QuotaManager(kvStore);
      const status = qm2.quotas.check(QUOTA_INFERENCE_CALLS);
      expect(status.usage.used).toBe(3);
    });
  });
});
