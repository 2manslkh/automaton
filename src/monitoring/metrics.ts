/**
 * Metrics Collection System
 *
 * Prometheus-compatible metrics: counters, gauges, and histograms
 * with label support for monitoring the automaton.
 */

// ─── Types ─────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricLabels {
  [key: string]: string;
}

interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labelNames: string[];
  buckets?: number[]; // histogram only
}

interface CounterValue {
  value: number;
}

interface GaugeValue {
  value: number;
}

interface HistogramValue {
  sum: number;
  count: number;
  buckets: Map<number, number>; // upper bound -> cumulative count
}

// ─── Metric Key Helper ─────────────────────────────────────────

function labelsKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${labels[k]}"`).join(",");
}

// ─── Metrics Registry ──────────────────────────────────────────

const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

export class MetricsRegistry {
  private definitions = new Map<string, MetricDefinition>();
  private counters = new Map<string, Map<string, CounterValue>>();
  private gauges = new Map<string, Map<string, GaugeValue>>();
  private histograms = new Map<string, Map<string, HistogramValue>>();

  // ── Define Metrics ──

  defineCounter(name: string, help: string, labelNames: string[] = []): void {
    this.definitions.set(name, { name, type: "counter", help, labelNames });
    if (!this.counters.has(name)) this.counters.set(name, new Map());
  }

  defineGauge(name: string, help: string, labelNames: string[] = []): void {
    this.definitions.set(name, { name, type: "gauge", help, labelNames });
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
  }

  defineHistogram(name: string, help: string, labelNames: string[] = [], buckets?: number[]): void {
    this.definitions.set(name, { name, type: "histogram", help, labelNames, buckets: buckets || DEFAULT_HISTOGRAM_BUCKETS });
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
  }

  // ── Counter Operations ──

  counterInc(name: string, labels: MetricLabels = {}, value = 1): void {
    const map = this.counters.get(name);
    if (!map) return;
    const key = labelsKey(labels);
    const existing = map.get(key);
    if (existing) {
      existing.value += value;
    } else {
      map.set(key, { value });
    }
  }

  counterGet(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(labelsKey(labels))?.value ?? 0;
  }

  // ── Gauge Operations ──

  gaugeSet(name: string, value: number, labels: MetricLabels = {}): void {
    const map = this.gauges.get(name);
    if (!map) return;
    map.set(labelsKey(labels), { value });
  }

  gaugeInc(name: string, labels: MetricLabels = {}, value = 1): void {
    const map = this.gauges.get(name);
    if (!map) return;
    const key = labelsKey(labels);
    const existing = map.get(key);
    if (existing) {
      existing.value += value;
    } else {
      map.set(key, { value });
    }
  }

  gaugeGet(name: string, labels: MetricLabels = {}): number {
    return this.gauges.get(name)?.get(labelsKey(labels))?.value ?? 0;
  }

  // ── Histogram Operations ──

  histogramObserve(name: string, value: number, labels: MetricLabels = {}): void {
    const map = this.histograms.get(name);
    const def = this.definitions.get(name);
    if (!map || !def || def.type !== "histogram") return;
    const key = labelsKey(labels);
    let hist = map.get(key);
    if (!hist) {
      hist = { sum: 0, count: 0, buckets: new Map() };
      for (const b of def.buckets!) {
        hist.buckets.set(b, 0);
      }
      map.set(key, hist);
    }
    hist.sum += value;
    hist.count += 1;
    for (const b of def.buckets!) {
      if (value <= b) {
        hist.buckets.set(b, (hist.buckets.get(b) || 0) + 1);
      }
    }
  }

  histogramGet(name: string, labels: MetricLabels = {}): { sum: number; count: number; buckets: [number, number][] } | null {
    const hist = this.histograms.get(name)?.get(labelsKey(labels));
    if (!hist) return null;
    const buckets: [number, number][] = [];
    for (const [bound, count] of hist.buckets) {
      buckets.push([bound, count]);
    }
    buckets.sort((a, b) => a[0] - b[0]);
    return { sum: hist.sum, count: hist.count, buckets };
  }

  // ── Introspection ──

  getDefinitions(): MetricDefinition[] {
    return [...this.definitions.values()];
  }

  getAllCounters(): Map<string, Map<string, CounterValue>> {
    return this.counters;
  }

  getAllGauges(): Map<string, Map<string, GaugeValue>> {
    return this.gauges;
  }

  getAllHistograms(): Map<string, Map<string, HistogramValue>> {
    return this.histograms;
  }

  /** Get a plain summary object for tool output */
  getSummary(): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [name, map] of this.counters) {
      for (const [key, val] of map) {
        summary[key ? `${name}{${key}}` : name] = val.value;
      }
    }
    for (const [name, map] of this.gauges) {
      for (const [key, val] of map) {
        summary[key ? `${name}{${key}}` : name] = val.value;
      }
    }
    for (const [name, map] of this.histograms) {
      for (const [key, val] of map) {
        const label = key ? `${name}{${key}}` : name;
        summary[`${label}_count`] = val.count;
        summary[`${label}_sum`] = val.sum;
      }
    }
    return summary;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    for (const def of this.definitions.values()) {
      if (def.type === "counter") this.counters.set(def.name, new Map());
      else if (def.type === "gauge") this.gauges.set(def.name, new Map());
      else if (def.type === "histogram") this.histograms.set(def.name, new Map());
    }
  }
}

// ─── Global Registry & Pre-defined Metrics ─────────────────────

let _registry: MetricsRegistry | undefined;

export function getMetricsRegistry(): MetricsRegistry {
  if (!_registry) {
    _registry = new MetricsRegistry();
    registerDefaultMetrics(_registry);
  }
  return _registry;
}

export function resetMetricsRegistry(): void {
  _registry = undefined;
}

function registerDefaultMetrics(r: MetricsRegistry): void {
  // Counters
  r.defineCounter("turns_total", "Total agent turns executed");
  r.defineCounter("tool_calls_total", "Total tool calls by tool name", ["tool_name"]);
  r.defineCounter("errors_total", "Total errors by type", ["error_type"]);
  r.defineCounter("inference_calls_total", "Total inference API calls", ["model"]);

  // Gauges
  r.defineGauge("credits_cents", "Current credit balance in cents");
  r.defineGauge("usdc_balance", "Current USDC balance");
  r.defineGauge("survival_tier", "Numeric survival tier (0=dead,1=critical,2=low_compute,3=warning,4=normal)");
  r.defineGauge("burn_rate_hourly", "Hourly burn rate in cents");
  r.defineGauge("active_servers", "Number of active HTTP servers");
  r.defineGauge("active_children", "Number of active child automatons");

  // Histograms
  r.defineHistogram("turn_duration_ms", "Turn duration in milliseconds", [], [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]);
  r.defineHistogram("tool_call_duration_ms", "Tool call duration in milliseconds", ["tool_name"], [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000]);
  r.defineHistogram("inference_latency_ms", "Inference API latency in milliseconds", ["model"], [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]);
}

// ─── Tier Numeric Mapping ──────────────────────────────────────

const TIER_NUMERIC: Record<string, number> = {
  dead: 0,
  critical: 1,
  low_compute: 2,
  warning: 3,
  normal: 4,
};

export function tierToNumeric(tier: string): number {
  return TIER_NUMERIC[tier] ?? -1;
}
