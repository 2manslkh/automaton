/**
 * Simple Alerting System
 *
 * Evaluates alert rules against metrics and tracks firing/resolved states.
 * Stores alert events as KV entries for agent memory integration.
 */

import { getMetricsRegistry, type MetricsRegistry } from "./metrics.js";
import type { AutomatonDatabase } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "firing" | "resolved";
export type AlertOperator = "lt" | "gt" | "eq" | "gte" | "lte";

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  metricName: string;
  metricType: "counter" | "gauge";
  operator: AlertOperator;
  threshold: number;
  severity: AlertSeverity;
  labels?: Record<string, string>;
  enabled: boolean;
}

export interface AlertEvent {
  ruleId: string;
  ruleName: string;
  state: AlertState;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  message: string;
  firedAt: string;
  resolvedAt?: string;
}

// ─── Operator Evaluation ───────────────────────────────────────

function evaluate(value: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "lt": return value < threshold;
    case "gt": return value > threshold;
    case "eq": return value === threshold;
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    default: return false;
  }
}

// ─── Alert Manager ─────────────────────────────────────────────

const ALERT_RULES_KEY = "alert_rules";
const ALERT_HISTORY_KEY = "alert_history";
const MAX_ALERT_HISTORY = 200;

export class AlertManager {
  private activeAlerts = new Map<string, AlertEvent>();

  constructor(
    private db: AutomatonDatabase | null = null,
    private registry: MetricsRegistry = getMetricsRegistry(),
  ) {
    // Load active alerts from DB
    if (db) {
      try {
        const raw = db.getKV("alert_active_state");
        if (raw) {
          const entries = JSON.parse(raw) as [string, AlertEvent][];
          for (const [k, v] of entries) this.activeAlerts.set(k, v);
        }
      } catch {}
    }
  }

  // ── Rule Management ──

  getRules(): AlertRule[] {
    if (!this.db) return [];
    const raw = this.db.getKV(ALERT_RULES_KEY);
    if (!raw) return getDefaultRules();
    try {
      return JSON.parse(raw) as AlertRule[];
    } catch {
      return getDefaultRules();
    }
  }

  addRule(rule: AlertRule): void {
    const rules = this.getRules();
    const idx = rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) rules[idx] = rule;
    else rules.push(rule);
    this.db?.setKV(ALERT_RULES_KEY, JSON.stringify(rules));
  }

  removeRule(id: string): boolean {
    const rules = this.getRules();
    const filtered = rules.filter((r) => r.id !== id);
    if (filtered.length === rules.length) return false;
    this.db?.setKV(ALERT_RULES_KEY, JSON.stringify(filtered));
    return true;
  }

  // ── Evaluation ──

  evaluateAll(): AlertEvent[] {
    const rules = this.getRules().filter((r) => r.enabled);
    const events: AlertEvent[] = [];
    const now = new Date().toISOString();

    for (const rule of rules) {
      let currentValue: number;
      if (rule.metricType === "counter") {
        currentValue = this.registry.counterGet(rule.metricName, rule.labels || {});
      } else {
        currentValue = this.registry.gaugeGet(rule.metricName, rule.labels || {});
      }

      const isFiring = evaluate(currentValue, rule.operator, rule.threshold);
      const existing = this.activeAlerts.get(rule.id);

      if (isFiring && !existing) {
        // New alert firing
        const event: AlertEvent = {
          ruleId: rule.id,
          ruleName: rule.name,
          state: "firing",
          severity: rule.severity,
          value: currentValue,
          threshold: rule.threshold,
          message: `${rule.name}: ${rule.metricName} is ${currentValue} (threshold: ${rule.operator} ${rule.threshold})`,
          firedAt: now,
        };
        this.activeAlerts.set(rule.id, event);
        events.push(event);
        this.recordAlert(event);
      } else if (!isFiring && existing) {
        // Alert resolved
        const event: AlertEvent = {
          ...existing,
          state: "resolved",
          value: currentValue,
          resolvedAt: now,
          message: `RESOLVED: ${rule.name} — ${rule.metricName} is ${currentValue}`,
        };
        this.activeAlerts.delete(rule.id);
        events.push(event);
        this.recordAlert(event);
      }
    }

    // Persist active state
    this.db?.setKV("alert_active_state", JSON.stringify([...this.activeAlerts.entries()]));

    return events;
  }

  getActiveAlerts(): AlertEvent[] {
    return [...this.activeAlerts.values()];
  }

  getAlertHistory(): AlertEvent[] {
    if (!this.db) return [];
    const raw = this.db.getKV(ALERT_HISTORY_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as AlertEvent[];
    } catch {
      return [];
    }
  }

  private recordAlert(event: AlertEvent): void {
    if (!this.db) return;
    const history = this.getAlertHistory();
    history.push(event);
    while (history.length > MAX_ALERT_HISTORY) history.shift();
    this.db.setKV(ALERT_HISTORY_KEY, JSON.stringify(history));

    // Store as episodic memory via KV (dashboard can pick it up)
    const memKey = `_alert_memory_${event.ruleId}_${Date.now()}`;
    this.db.setKV(memKey, JSON.stringify({
      type: "alert",
      content: event.message,
      importance: event.severity === "critical" ? 9 : event.severity === "warning" ? 6 : 3,
      timestamp: event.state === "resolved" ? event.resolvedAt : event.firedAt,
    }));
  }
}

// ─── Default Alert Rules ───────────────────────────────────────

function getDefaultRules(): AlertRule[] {
  return [
    {
      id: "credits_low",
      name: "Credits Low",
      description: "Credits balance below $1",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 100,
      severity: "critical",
      enabled: true,
    },
    {
      id: "credits_warning",
      name: "Credits Warning",
      description: "Credits balance below $5",
      metricName: "credits_cents",
      metricType: "gauge",
      operator: "lt",
      threshold: 500,
      severity: "warning",
      enabled: true,
    },
    {
      id: "burn_rate_high",
      name: "High Burn Rate",
      description: "Burn rate exceeds 500 cents/hr",
      metricName: "burn_rate_hourly",
      metricType: "gauge",
      operator: "gt",
      threshold: 500,
      severity: "warning",
      enabled: true,
    },
    {
      id: "errors_high",
      name: "High Error Rate",
      description: "More than 50 errors accumulated",
      metricName: "errors_total",
      metricType: "counter",
      operator: "gt",
      threshold: 50,
      severity: "warning",
      enabled: true,
    },
    {
      id: "no_children",
      name: "No Active Children",
      description: "All children are dead",
      metricName: "active_children",
      metricType: "gauge",
      operator: "eq",
      threshold: 0,
      severity: "info",
      enabled: false, // disabled by default since not everyone has children
    },
  ];
}

// ─── Singleton ─────────────────────────────────────────────────

let _alertManager: AlertManager | undefined;

export function getAlertManager(db?: AutomatonDatabase): AlertManager {
  if (!_alertManager) {
    _alertManager = new AlertManager(db || null);
  }
  return _alertManager;
}

export function resetAlertManager(): void {
  _alertManager = undefined;
}
