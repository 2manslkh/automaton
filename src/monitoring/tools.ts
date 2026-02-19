/**
 * Monitoring Tools
 *
 * Agent-callable tools for metrics inspection and alert management.
 */

import type { AutomatonTool, AutomatonDatabase } from "../types.js";
import { getMetricsRegistry } from "./metrics.js";
import { renderPrometheusMetrics } from "./prometheus.js";
import { getAlertManager, type AlertRule } from "./alerting.js";

export function createMonitoringTools(db: AutomatonDatabase): AutomatonTool[] {
  const metrics_summary: AutomatonTool = {
    name: "metrics_summary",
    description: "Get a summary of all collected metrics (counters, gauges, histograms).",
    category: "system" as any,
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Output format: 'json' (default) or 'prometheus'",
        },
      },
    },
    execute: async (args) => {
      const registry = getMetricsRegistry();
      const format = (args.format as string) || "json";
      if (format === "prometheus") {
        return renderPrometheusMetrics(registry);
      }
      return JSON.stringify(registry.getSummary(), null, 2);
    },
  };

  const list_alerts: AutomatonTool = {
    name: "list_alerts",
    description: "List all active alerts and recent alert history.",
    category: "system" as any,
    parameters: {
      type: "object",
      properties: {
        includeHistory: {
          type: "boolean",
          description: "Include alert history (default: false)",
        },
      },
    },
    execute: async (args) => {
      const manager = getAlertManager(db);
      const active = manager.getActiveAlerts();
      const result: Record<string, unknown> = {
        activeAlerts: active,
        rules: manager.getRules().map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, severity: r.severity })),
      };
      if (args.includeHistory) {
        result.history = manager.getAlertHistory().slice(-20);
      }
      return JSON.stringify(result, null, 2);
    },
  };

  const add_alert_rule: AutomatonTool = {
    name: "add_alert_rule",
    description: "Add or update an alert rule. Specify metric name, operator (lt/gt/eq/gte/lte), threshold, and severity.",
    category: "system" as any,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique rule ID" },
        name: { type: "string", description: "Human-readable rule name" },
        description: { type: "string", description: "Rule description" },
        metricName: { type: "string", description: "Name of the metric to monitor" },
        metricType: { type: "string", description: "'counter' or 'gauge'" },
        operator: { type: "string", description: "Comparison operator: lt, gt, eq, gte, lte" },
        threshold: { type: "number", description: "Threshold value" },
        severity: { type: "string", description: "Alert severity: info, warning, critical" },
        enabled: { type: "boolean", description: "Whether the rule is enabled (default: true)" },
      },
      required: ["id", "name", "metricName", "metricType", "operator", "threshold"],
    },
    execute: async (args) => {
      const manager = getAlertManager(db);
      const rule: AlertRule = {
        id: args.id as string,
        name: args.name as string,
        description: (args.description as string) || "",
        metricName: args.metricName as string,
        metricType: args.metricType as "counter" | "gauge",
        operator: args.operator as any,
        threshold: args.threshold as number,
        severity: (args.severity as any) || "warning",
        enabled: args.enabled !== false,
      };
      manager.addRule(rule);
      return `Alert rule '${rule.id}' saved: ${rule.name} — ${rule.metricName} ${rule.operator} ${rule.threshold} [${rule.severity}]`;
    },
  };

  return [metrics_summary, list_alerts, add_alert_rule];
}
