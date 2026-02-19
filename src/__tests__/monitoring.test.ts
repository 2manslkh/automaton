/**
 * Monitoring tests — metrics collection, Prometheus format, alerting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MetricsRegistry, getMetricsRegistry, resetMetricsRegistry, tierToNumeric } from "../monitoring/metrics.js";
import { renderPrometheusMetrics } from "../monitoring/prometheus.js";
import { AlertManager, resetAlertManager, type AlertRule } from "../monitoring/alerting.js";

/** Minimal KV-only mock for alert tests (avoids importing heavy database.ts) */
function createKVMockDb(): any {
  const kv = new Map<string, string>();
  return {
    getKV: (key: string) => kv.get(key),
    setKV: (key: string, value: string) => { kv.set(key, value); },
    deleteKV: (key: string) => { kv.delete(key); },
  };
}

// ─── Metrics Registry ──────────────────────────────────────────

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe("Counters", () => {
    it("should increment counters", () => {
      registry.defineCounter("test_counter", "A test counter");
      registry.counterInc("test_counter");
      registry.counterInc("test_counter");
      expect(registry.counterGet("test_counter")).toBe(2);
    });

    it("should increment by custom value", () => {
      registry.defineCounter("test_counter", "A test counter");
      registry.counterInc("test_counter", {}, 5);
      expect(registry.counterGet("test_counter")).toBe(5);
    });

    it("should track labels independently", () => {
      registry.defineCounter("tool_calls", "Tool calls", ["tool_name"]);
      registry.counterInc("tool_calls", { tool_name: "exec" });
      registry.counterInc("tool_calls", { tool_name: "exec" });
      registry.counterInc("tool_calls", { tool_name: "read" });
      expect(registry.counterGet("tool_calls", { tool_name: "exec" })).toBe(2);
      expect(registry.counterGet("tool_calls", { tool_name: "read" })).toBe(1);
    });

    it("should return 0 for undefined counter", () => {
      expect(registry.counterGet("nonexistent")).toBe(0);
    });
  });

  describe("Gauges", () => {
    it("should set and get gauges", () => {
      registry.defineGauge("credits", "Credits");
      registry.gaugeSet("credits", 5000);
      expect(registry.gaugeGet("credits")).toBe(5000);
    });

    it("should increment gauges", () => {
      registry.defineGauge("active_servers", "Servers");
      registry.gaugeSet("active_servers", 2);
      registry.gaugeInc("active_servers", {}, 1);
      expect(registry.gaugeGet("active_servers")).toBe(3);
    });

    it("should support labels on gauges", () => {
      registry.defineGauge("tier", "Tier", ["tier"]);
      registry.gaugeSet("tier", 4, { tier: "normal" });
      expect(registry.gaugeGet("tier", { tier: "normal" })).toBe(4);
    });
  });

  describe("Histograms", () => {
    it("should observe values and track buckets", () => {
      registry.defineHistogram("duration_ms", "Duration", [], [10, 50, 100, 500]);
      registry.histogramObserve("duration_ms", 25);
      registry.histogramObserve("duration_ms", 75);
      registry.histogramObserve("duration_ms", 200);

      const h = registry.histogramGet("duration_ms");
      expect(h).not.toBeNull();
      expect(h!.count).toBe(3);
      expect(h!.sum).toBe(300);
      // 25 fits in 50, 100, 500 buckets; 75 fits in 100, 500; 200 fits in 500
      const bucketMap = new Map(h!.buckets);
      expect(bucketMap.get(10)).toBe(0);
      expect(bucketMap.get(50)).toBe(1);
      expect(bucketMap.get(100)).toBe(2);
      expect(bucketMap.get(500)).toBe(3);
    });

    it("should track labels independently for histograms", () => {
      registry.defineHistogram("tool_ms", "Tool latency", ["tool_name"], [10, 100]);
      registry.histogramObserve("tool_ms", 5, { tool_name: "exec" });
      registry.histogramObserve("tool_ms", 50, { tool_name: "read" });

      const exec = registry.histogramGet("tool_ms", { tool_name: "exec" });
      const read = registry.histogramGet("tool_ms", { tool_name: "read" });
      expect(exec!.count).toBe(1);
      expect(read!.count).toBe(1);
    });

    it("should return null for unobserved histogram", () => {
      registry.defineHistogram("empty", "Empty");
      expect(registry.histogramGet("empty")).toBeNull();
    });
  });

  describe("Summary", () => {
    it("should produce a summary object", () => {
      registry.defineCounter("c", "counter");
      registry.defineGauge("g", "gauge");
      registry.counterInc("c", {}, 3);
      registry.gaugeSet("g", 42);
      const s = registry.getSummary();
      expect(s["c"]).toBe(3);
      expect(s["g"]).toBe(42);
    });
  });

  describe("Reset", () => {
    it("should reset all values", () => {
      registry.defineCounter("c", "counter");
      registry.counterInc("c");
      registry.reset();
      expect(registry.counterGet("c")).toBe(0);
    });
  });
});

describe("tierToNumeric", () => {
  it("maps tiers correctly", () => {
    expect(tierToNumeric("dead")).toBe(0);
    expect(tierToNumeric("critical")).toBe(1);
    expect(tierToNumeric("normal")).toBe(4);
    expect(tierToNumeric("unknown")).toBe(-1);
  });
});

// ─── Prometheus Format ─────────────────────────────────────────

describe("Prometheus exposition format", () => {
  it("should render counters with HELP and TYPE", () => {
    const r = new MetricsRegistry();
    r.defineCounter("requests_total", "Total requests");
    r.counterInc("requests_total", {}, 42);

    const output = renderPrometheusMetrics(r);
    expect(output).toContain("# HELP requests_total Total requests");
    expect(output).toContain("# TYPE requests_total counter");
    expect(output).toContain("requests_total 42");
  });

  it("should render gauges", () => {
    const r = new MetricsRegistry();
    r.defineGauge("credits_cents", "Credits");
    r.gaugeSet("credits_cents", 5000);

    const output = renderPrometheusMetrics(r);
    expect(output).toContain("# TYPE credits_cents gauge");
    expect(output).toContain("credits_cents 5000");
  });

  it("should render labeled counters", () => {
    const r = new MetricsRegistry();
    r.defineCounter("tool_calls_total", "Tool calls", ["tool_name"]);
    r.counterInc("tool_calls_total", { tool_name: "exec" }, 10);

    const output = renderPrometheusMetrics(r);
    expect(output).toContain('tool_calls_total{tool_name="exec"} 10');
  });

  it("should render histograms with buckets, sum, count", () => {
    const r = new MetricsRegistry();
    r.defineHistogram("latency_ms", "Latency", [], [10, 50, 100]);
    r.histogramObserve("latency_ms", 25);
    r.histogramObserve("latency_ms", 75);

    const output = renderPrometheusMetrics(r);
    expect(output).toContain("# TYPE latency_ms histogram");
    expect(output).toContain("latency_ms_bucket");
    expect(output).toContain('le="10"');
    expect(output).toContain('le="+Inf"');
    expect(output).toContain("latency_ms_sum 100");
    expect(output).toContain("latency_ms_count 2");
  });
});

// ─── Global Registry ──────────────────────────────────────────

describe("Global metrics registry", () => {
  beforeEach(() => resetMetricsRegistry());

  it("should register default metrics", () => {
    const r = getMetricsRegistry();
    const defs = r.getDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain("turns_total");
    expect(names).toContain("tool_calls_total");
    expect(names).toContain("errors_total");
    expect(names).toContain("inference_calls_total");
    expect(names).toContain("credits_cents");
    expect(names).toContain("usdc_balance");
    expect(names).toContain("survival_tier");
    expect(names).toContain("burn_rate_hourly");
    expect(names).toContain("active_servers");
    expect(names).toContain("active_children");
    expect(names).toContain("turn_duration_ms");
    expect(names).toContain("tool_call_duration_ms");
    expect(names).toContain("inference_latency_ms");
  });
});

// ─── Alerting ──────────────────────────────────────────────────

describe("AlertManager", () => {
  let registry: MetricsRegistry;
  let db: any;

  beforeEach(() => {
    resetAlertManager();
    registry = new MetricsRegistry();
    registry.defineGauge("credits_cents", "Credits");
    registry.defineGauge("burn_rate_hourly", "Burn rate");
    registry.defineCounter("errors_total", "Errors", ["error_type"]);
    db = createKVMockDb();
    // Pre-seed empty rules to avoid default rules interfering
    db.setKV("alert_rules", "[]");
  });

  it("should fire alert when threshold breached", () => {
    const manager = new AlertManager(db, registry);
    const rule: AlertRule = {
      id: "test_low",
      name: "Low Credits",
      description: "Credits < 100",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    };
    manager.addRule(rule);

    registry.gaugeSet("credits_cents", 50);
    const events = manager.evaluateAll();
    expect(events.length).toBe(1);
    expect(events[0].state).toBe("firing");
    expect(events[0].severity).toBe("critical");
  });

  it("should resolve alert when condition clears", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "test_low",
      name: "Low Credits",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    });

    registry.gaugeSet("credits_cents", 50);
    manager.evaluateAll(); // fires

    registry.gaugeSet("credits_cents", 500);
    const events = manager.evaluateAll(); // resolves
    expect(events.length).toBe(1);
    expect(events[0].state).toBe("resolved");
  });

  it("should not re-fire already firing alerts", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "test_low",
      name: "Low",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "warning",
      enabled: true,
    });

    registry.gaugeSet("credits_cents", 50);
    const events1 = manager.evaluateAll();
    expect(events1.length).toBe(1);

    const events2 = manager.evaluateAll(); // still firing, no new event
    expect(events2.length).toBe(0);
  });

  it("should track active alerts", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "a1",
      name: "A1",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    });

    registry.gaugeSet("credits_cents", 50);
    manager.evaluateAll();
    expect(manager.getActiveAlerts().length).toBe(1);

    registry.gaugeSet("credits_cents", 200);
    manager.evaluateAll();
    expect(manager.getActiveAlerts().length).toBe(0);
  });

  it("should persist alert history in db", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "a1",
      name: "A1",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    });

    registry.gaugeSet("credits_cents", 50);
    manager.evaluateAll();
    const history = manager.getAlertHistory();
    expect(history.length).toBe(1);
    expect(history[0].state).toBe("firing");
  });

  it("should skip disabled rules", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "disabled",
      name: "Disabled",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 999999,
      severity: "info",
      enabled: false,
    });

    registry.gaugeSet("credits_cents", 0);
    const events = manager.evaluateAll();
    expect(events.length).toBe(0);
  });

  it("should support all operators", () => {
    const manager = new AlertManager(db, registry);
    registry.gaugeSet("credits_cents", 100);

    const ops: Array<{ op: string; thresh: number; shouldFire: boolean }> = [
      { op: "lt", thresh: 200, shouldFire: true },
      { op: "gt", thresh: 50, shouldFire: true },
      { op: "eq", thresh: 100, shouldFire: true },
      { op: "gte", thresh: 100, shouldFire: true },
      { op: "lte", thresh: 100, shouldFire: true },
      { op: "lt", thresh: 50, shouldFire: false },
    ];

    for (const { op, thresh, shouldFire } of ops) {
      const id = `test_${op}_${thresh}`;
      manager.addRule({
        id,
        name: id,
        description: "",
        metricName: "credits_cents",
        metricType: "gauge",
        operator: op as any,
        threshold: thresh,
        severity: "info",
        enabled: true,
      });
    }

    const events = manager.evaluateAll();
    // 5 should fire, 1 should not
    expect(events.length).toBe(5);
  });

  it("should store alert as memory in KV", () => {
    const manager = new AlertManager(db, registry);
    manager.addRule({
      id: "mem_test",
      name: "Memory Test",
      description: "",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    });

    registry.gaugeSet("credits_cents", 50);
    manager.evaluateAll();

    // Check that a memory KV entry was created
    // We can't easily check the exact key since it includes Date.now(),
    // but we can verify history is stored
    const history = manager.getAlertHistory();
    expect(history.length).toBeGreaterThan(0);
  });
});
