/**
 * Standalone test runner for monitoring module.
 * Run with: node --experimental-strip-types --experimental-transform-types src/__tests__/monitoring.runner.ts
 */

import { MetricsRegistry, getMetricsRegistry, resetMetricsRegistry, tierToNumeric } from "../monitoring/metrics.js";
import { renderPrometheusMetrics } from "../monitoring/prometheus.js";
import { AlertManager, resetAlertManager } from "../monitoring/alerting.js";
import type { AlertRule } from "../monitoring/alerting.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    failed++;
    console.error(`  ✗ ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function eq(a: any, b: any, msg: string) {
  assert(a === b, `${msg} (got ${a}, expected ${b})`);
}

function createKVMockDb(): any {
  const kv = new Map<string, string>();
  return {
    getKV: (key: string) => kv.get(key),
    setKV: (key: string, value: string) => { kv.set(key, value); },
    deleteKV: (key: string) => { kv.delete(key); },
  };
}

// ── Counter Tests ──
console.log("\n=== Counters ===");
{
  const r = new MetricsRegistry();
  r.defineCounter("c", "test");
  r.counterInc("c");
  r.counterInc("c");
  eq(r.counterGet("c"), 2, "increment counter");

  r.counterInc("c", {}, 5);
  eq(r.counterGet("c"), 7, "increment by custom value");
}

{
  const r = new MetricsRegistry();
  r.defineCounter("tc", "tool calls", ["tool_name"]);
  r.counterInc("tc", { tool_name: "exec" });
  r.counterInc("tc", { tool_name: "exec" });
  r.counterInc("tc", { tool_name: "read" });
  eq(r.counterGet("tc", { tool_name: "exec" }), 2, "labeled counter exec=2");
  eq(r.counterGet("tc", { tool_name: "read" }), 1, "labeled counter read=1");
  eq(r.counterGet("nonexistent"), 0, "undefined counter = 0");
}

// ── Gauge Tests ──
console.log("\n=== Gauges ===");
{
  const r = new MetricsRegistry();
  r.defineGauge("credits", "Credits");
  r.gaugeSet("credits", 5000);
  eq(r.gaugeGet("credits"), 5000, "set and get gauge");

  r.defineGauge("servers", "Servers");
  r.gaugeSet("servers", 2);
  r.gaugeInc("servers", {}, 1);
  eq(r.gaugeGet("servers"), 3, "increment gauge");
}

// ── Histogram Tests ──
console.log("\n=== Histograms ===");
{
  const r = new MetricsRegistry();
  r.defineHistogram("dur", "Duration", [], [10, 50, 100, 500]);
  r.histogramObserve("dur", 25);
  r.histogramObserve("dur", 75);
  r.histogramObserve("dur", 200);

  const h = r.histogramGet("dur");
  assert(h !== null, "histogram not null");
  eq(h!.count, 3, "histogram count=3");
  eq(h!.sum, 300, "histogram sum=300");
  const bm = new Map(h!.buckets);
  eq(bm.get(10), 0, "bucket 10=0");
  eq(bm.get(50), 1, "bucket 50=1");
  eq(bm.get(100), 2, "bucket 100=2");
  eq(bm.get(500), 3, "bucket 500=3");

  assert(r.histogramGet("dur", { nonexistent: "x" }) === null, "unobserved labels = null");
}

// ── Summary ──
console.log("\n=== Summary ===");
{
  const r = new MetricsRegistry();
  r.defineCounter("c", "counter");
  r.defineGauge("g", "gauge");
  r.counterInc("c", {}, 3);
  r.gaugeSet("g", 42);
  const s = r.getSummary();
  eq(s["c"], 3, "summary counter");
  eq(s["g"], 42, "summary gauge");
}

// ── Reset ──
console.log("\n=== Reset ===");
{
  const r = new MetricsRegistry();
  r.defineCounter("c", "counter");
  r.counterInc("c");
  r.reset();
  eq(r.counterGet("c"), 0, "reset clears values");
}

// ── Tier Numeric ──
console.log("\n=== tierToNumeric ===");
eq(tierToNumeric("dead"), 0, "dead=0");
eq(tierToNumeric("critical"), 1, "critical=1");
eq(tierToNumeric("normal"), 4, "normal=4");
eq(tierToNumeric("unknown"), -1, "unknown=-1");

// ── Prometheus Format ──
console.log("\n=== Prometheus Format ===");
{
  const r = new MetricsRegistry();
  r.defineCounter("requests_total", "Total requests");
  r.counterInc("requests_total", {}, 42);
  const out = renderPrometheusMetrics(r);
  assert(out.includes("# HELP requests_total Total requests"), "HELP comment");
  assert(out.includes("# TYPE requests_total counter"), "TYPE comment");
  assert(out.includes("requests_total 42"), "counter value");
}
{
  const r = new MetricsRegistry();
  r.defineGauge("credits_cents", "Credits");
  r.gaugeSet("credits_cents", 5000);
  const out = renderPrometheusMetrics(r);
  assert(out.includes("# TYPE credits_cents gauge"), "gauge TYPE");
  assert(out.includes("credits_cents 5000"), "gauge value");
}
{
  const r = new MetricsRegistry();
  r.defineCounter("tool_calls_total", "Tool calls", ["tool_name"]);
  r.counterInc("tool_calls_total", { tool_name: "exec" }, 10);
  const out = renderPrometheusMetrics(r);
  assert(out.includes('tool_calls_total{tool_name="exec"} 10'), "labeled counter");
}
{
  const r = new MetricsRegistry();
  r.defineHistogram("latency_ms", "Latency", [], [10, 50, 100]);
  r.histogramObserve("latency_ms", 25);
  r.histogramObserve("latency_ms", 75);
  const out = renderPrometheusMetrics(r);
  assert(out.includes("# TYPE latency_ms histogram"), "histogram TYPE");
  assert(out.includes("latency_ms_bucket"), "bucket lines");
  assert(out.includes('le="10"'), "le=10");
  assert(out.includes('le="+Inf"'), "le=+Inf");
  assert(out.includes("latency_ms_sum 100"), "histogram sum");
  assert(out.includes("latency_ms_count 2"), "histogram count");
}

// ── Global Registry ──
console.log("\n=== Global Registry ===");
{
  resetMetricsRegistry();
  const r = getMetricsRegistry();
  const names = r.getDefinitions().map(d => d.name);
  for (const n of ["turns_total", "tool_calls_total", "errors_total", "inference_calls_total",
                    "credits_cents", "usdc_balance", "survival_tier", "burn_rate_hourly",
                    "active_servers", "active_children", "turn_duration_ms",
                    "tool_call_duration_ms", "inference_latency_ms"]) {
    assert(names.includes(n), `default metric '${n}' registered`);
  }
}

// ── Alerting ──
console.log("\n=== Alerting ===");
{
  const registry = new MetricsRegistry();
  registry.defineGauge("credits_cents", "Credits");
  registry.defineCounter("errors_total", "Errors", ["error_type"]);
  const db = createKVMockDb();
  db.setKV("alert_rules", "[]");

  // Fire alert
  const manager = new AlertManager(db, registry);
  const rule: AlertRule = {
    id: "test_low", name: "Low Credits", description: "",
    metricName: "credits_cents", metricType: "gauge",
    operator: "lt", threshold: 100, severity: "critical", enabled: true,
  };
  manager.addRule(rule);
  registry.gaugeSet("credits_cents", 50);
  const events = manager.evaluateAll();
  eq(events.length, 1, "alert fires");
  eq(events[0].state, "firing", "state=firing");
  eq(events[0].severity, "critical", "severity=critical");

  // No re-fire
  const events2 = manager.evaluateAll();
  eq(events2.length, 0, "no re-fire");

  // Resolve
  registry.gaugeSet("credits_cents", 500);
  const events3 = manager.evaluateAll();
  eq(events3.length, 1, "alert resolves");
  eq(events3[0].state, "resolved", "state=resolved");
  eq(manager.getActiveAlerts().length, 0, "no active alerts after resolve");

  // History
  const history = manager.getAlertHistory();
  assert(history.length >= 2, "alert history has fire+resolve");
}

// Disabled rules
{
  const registry = new MetricsRegistry();
  registry.defineGauge("credits_cents", "Credits");
  const db = createKVMockDb();
  db.setKV("alert_rules", "[]");
  const manager = new AlertManager(db, registry);
  manager.addRule({
    id: "disabled", name: "Disabled", description: "",
    metricName: "credits_cents", metricType: "gauge",
    operator: "lt", threshold: 999999, severity: "info", enabled: false,
  });
  registry.gaugeSet("credits_cents", 0);
  eq(manager.evaluateAll().length, 0, "disabled rules skipped");
}

// All operators
{
  const registry = new MetricsRegistry();
  registry.defineGauge("credits_cents", "Credits");
  const db = createKVMockDb();
  db.setKV("alert_rules", "[]");
  const manager = new AlertManager(db, registry);
  registry.gaugeSet("credits_cents", 100);

  const ops = [
    { op: "lt", thresh: 200, fires: true },
    { op: "gt", thresh: 50, fires: true },
    { op: "eq", thresh: 100, fires: true },
    { op: "gte", thresh: 100, fires: true },
    { op: "lte", thresh: 100, fires: true },
    { op: "lt", thresh: 50, fires: false },
  ];
  for (const { op, thresh } of ops) {
    manager.addRule({
      id: `${op}_${thresh}`, name: `${op}_${thresh}`, description: "",
      metricName: "credits_cents", metricType: "gauge",
      operator: op as any, threshold: thresh, severity: "info", enabled: true,
    });
  }
  const events = manager.evaluateAll();
  eq(events.length, 5, "5 of 6 operators fire");
}

// ── Results ──
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All tests passed! ✅");
