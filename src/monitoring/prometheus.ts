/**
 * Prometheus Exposition Format
 *
 * Renders all metrics in standard Prometheus text format for scraping.
 */

import type { MetricsRegistry, MetricLabels } from "./metrics.js";

/**
 * Render all metrics in Prometheus exposition format.
 */
export function renderPrometheusMetrics(registry: MetricsRegistry): string {
  const lines: string[] = [];
  const definitions = registry.getDefinitions();

  for (const def of definitions) {
    lines.push(`# HELP ${def.name} ${def.help}`);

    if (def.type === "counter") {
      lines.push(`# TYPE ${def.name} counter`);
      const map = registry.getAllCounters().get(def.name);
      if (map) {
        for (const [labelsStr, val] of map) {
          lines.push(`${def.name}${labelsStr ? `{${labelsStr}}` : ""} ${val.value}`);
        }
      }
    } else if (def.type === "gauge") {
      lines.push(`# TYPE ${def.name} gauge`);
      const map = registry.getAllGauges().get(def.name);
      if (map) {
        for (const [labelsStr, val] of map) {
          lines.push(`${def.name}${labelsStr ? `{${labelsStr}}` : ""} ${val.value}`);
        }
      }
    } else if (def.type === "histogram") {
      lines.push(`# TYPE ${def.name} histogram`);
      const map = registry.getAllHistograms().get(def.name);
      if (map) {
        for (const [labelsStr, val] of map) {
          const labelPrefix = labelsStr ? `{${labelsStr},` : "{";
          const labelSuffix = labelsStr ? "}" : "}";
          // Sort buckets by bound
          const sortedBuckets = [...val.buckets.entries()].sort((a, b) => a[0] - b[0]);
          for (const [bound, count] of sortedBuckets) {
            const le = bound === Infinity ? "+Inf" : String(bound);
            lines.push(`${def.name}_bucket${labelPrefix}le="${le}"${labelsStr ? "" : labelSuffix} ${count}`);
          }
          // +Inf bucket = total count
          lines.push(`${def.name}_bucket${labelPrefix}le="+Inf"${labelsStr ? "" : labelSuffix} ${val.count}`);
          lines.push(`${def.name}_sum${labelsStr ? `{${labelsStr}}` : ""} ${val.sum}`);
          lines.push(`${def.name}_count${labelsStr ? `{${labelsStr}}` : ""} ${val.count}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}
