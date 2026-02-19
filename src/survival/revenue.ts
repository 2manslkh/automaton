/**
 * Revenue Tracking System
 *
 * Tracks income and expense events, calculates P&L (daily, weekly, all-time),
 * profitability ratios, and runway projections based on net burn rate.
 */

import type { AutomatonDatabase } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────

export type RevenueEventType =
  | "x402_payment"
  | "credit_transfer_in"
  | "service_payment"
  | "inference_cost"
  | "credit_transfer_out"
  | "domain_purchase"
  | "other_income"
  | "other_expense";

export interface RevenueEvent {
  id: string;
  type: RevenueEventType;
  category: "income" | "expense";
  amountCents: number;
  source: string;
  description: string;
  timestamp: string;
}

export interface PnLReport {
  period: string;
  totalRevenue: number;
  totalExpenses: number;
  netPnL: number;
  profitabilityRatio: number;
  eventCount: number;
}

export interface RevenueDashboard {
  daily: PnLReport;
  weekly: PnLReport;
  allTime: PnLReport;
  topRevenueSources: { source: string; amount: number }[];
  costBreakdown: { type: string; amount: number }[];
  trend: "improving" | "declining" | "stable" | "insufficient_data";
  runwayDays: number | null;
  runwayHours: number | null;
}

// ─── Category helpers ──────────────────────────────────────────

const INCOME_TYPES: RevenueEventType[] = [
  "x402_payment",
  "credit_transfer_in",
  "service_payment",
  "other_income",
];

const EXPENSE_TYPES: RevenueEventType[] = [
  "inference_cost",
  "credit_transfer_out",
  "domain_purchase",
  "other_expense",
];

export function categoryForType(type: RevenueEventType): "income" | "expense" {
  return INCOME_TYPES.includes(type) ? "income" : "expense";
}

// ─── Revenue Event Storage (via KV) ───────────────────────────

const REVENUE_EVENTS_KEY = "revenue_events";
const MAX_EVENTS = 10000;

function getEvents(db: AutomatonDatabase): RevenueEvent[] {
  const raw = db.getKV(REVENUE_EVENTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RevenueEvent[];
  } catch {
    return [];
  }
}

function saveEvents(db: AutomatonDatabase, events: RevenueEvent[]): void {
  // Prune to max
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
  db.setKV(REVENUE_EVENTS_KEY, JSON.stringify(events));
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Log a revenue event (income or expense).
 */
export function logRevenueEvent(
  db: AutomatonDatabase,
  event: Omit<RevenueEvent, "category">,
): RevenueEvent {
  const fullEvent: RevenueEvent = {
    ...event,
    category: categoryForType(event.type),
  };
  const events = getEvents(db);
  events.push(fullEvent);
  saveEvents(db, events);

  // Update running totals in KV for quick access
  if (fullEvent.category === "income") {
    const current = parseFloat(db.getKV("total_earned_cents") || "0");
    db.setKV("total_earned_cents", (current + fullEvent.amountCents).toString());
  } else {
    const current = parseFloat(db.getKV("total_spend_cents") || "0");
    db.setKV("total_spend_cents", (current + fullEvent.amountCents).toString());
  }

  return fullEvent;
}

/**
 * Log an inference cost as an expense event.
 */
export function logInferenceCost(
  db: AutomatonDatabase,
  costCents: number,
  model: string,
  turnId: string,
): RevenueEvent {
  return logRevenueEvent(db, {
    id: `inf-${turnId}`,
    type: "inference_cost",
    amountCents: costCents,
    source: model,
    description: `Inference cost for turn ${turnId}`,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log an x402 payment received as income.
 */
export function logX402Payment(
  db: AutomatonDatabase,
  amountCents: number,
  route: string,
  requestId?: string,
): RevenueEvent {
  const id = requestId || `x402-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return logRevenueEvent(db, {
    id,
    type: "x402_payment",
    amountCents,
    source: route,
    description: `x402 payment received on ${route}`,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log a generic income event.
 */
export function logIncome(
  db: AutomatonDatabase,
  type: "credit_transfer_in" | "service_payment" | "other_income",
  amountCents: number,
  source: string,
  description: string,
): RevenueEvent {
  const id = `inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return logRevenueEvent(db, {
    id,
    type,
    amountCents,
    source,
    description,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log a generic expense event.
 */
export function logExpense(
  db: AutomatonDatabase,
  type: "credit_transfer_out" | "domain_purchase" | "other_expense",
  amountCents: number,
  source: string,
  description: string,
): RevenueEvent {
  const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return logRevenueEvent(db, {
    id,
    type,
    amountCents,
    source,
    description,
    timestamp: new Date().toISOString(),
  });
}

// ─── P&L Calculation ──────────────────────────────────────────

function filterEventsByPeriod(events: RevenueEvent[], since: Date): RevenueEvent[] {
  const sinceStr = since.toISOString();
  return events.filter((e) => e.timestamp >= sinceStr);
}

export function calculatePnL(events: RevenueEvent[], period: string): PnLReport {
  const totalRevenue = events
    .filter((e) => e.category === "income")
    .reduce((sum, e) => sum + e.amountCents, 0);
  const totalExpenses = events
    .filter((e) => e.category === "expense")
    .reduce((sum, e) => sum + e.amountCents, 0);
  const netPnL = totalRevenue - totalExpenses;
  const profitabilityRatio = totalExpenses > 0 ? totalRevenue / totalExpenses : totalRevenue > 0 ? Infinity : 0;

  return {
    period,
    totalRevenue,
    totalExpenses,
    netPnL,
    profitabilityRatio: Math.round(profitabilityRatio * 100) / 100,
    eventCount: events.length,
  };
}

export function getDailyPnL(db: AutomatonDatabase): PnLReport {
  const events = getEvents(db);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return calculatePnL(filterEventsByPeriod(events, since), "daily");
}

export function getWeeklyPnL(db: AutomatonDatabase): PnLReport {
  const events = getEvents(db);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return calculatePnL(filterEventsByPeriod(events, since), "weekly");
}

export function getAllTimePnL(db: AutomatonDatabase): PnLReport {
  return calculatePnL(getEvents(db), "all-time");
}

// ─── Runway Projection ───────────────────────────────────────

/**
 * Project runway based on net burn rate.
 * Uses weekly data if available, falls back to daily.
 */
export function projectRunway(
  db: AutomatonDatabase,
  currentBalanceCents: number,
): { runwayHours: number | null; runwayDays: number | null; netBurnPerHour: number } {
  const events = getEvents(db);
  if (events.length < 2) {
    return { runwayHours: null, runwayDays: null, netBurnPerHour: 0 };
  }

  // Find the time span of events
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstTime = new Date(sorted[0].timestamp).getTime();
  const lastTime = new Date(sorted[sorted.length - 1].timestamp).getTime();
  const hoursSpan = (lastTime - firstTime) / (1000 * 60 * 60);

  if (hoursSpan < 0.01) {
    return { runwayHours: null, runwayDays: null, netBurnPerHour: 0 };
  }

  const totalRevenue = events
    .filter((e) => e.category === "income")
    .reduce((sum, e) => sum + e.amountCents, 0);
  const totalExpenses = events
    .filter((e) => e.category === "expense")
    .reduce((sum, e) => sum + e.amountCents, 0);

  const netBurnPerHour = (totalExpenses - totalRevenue) / hoursSpan;

  if (netBurnPerHour <= 0) {
    // Profitable or break-even — infinite runway
    return { runwayHours: null, runwayDays: null, netBurnPerHour };
  }

  const runwayHours = Math.round((currentBalanceCents / netBurnPerHour) * 10) / 10;
  const runwayDays = Math.round((runwayHours / 24) * 10) / 10;

  return { runwayHours, runwayDays, netBurnPerHour: Math.round(netBurnPerHour * 100) / 100 };
}

// ─── Trend Analysis ───────────────────────────────────────────

/**
 * Compare last 3 days vs prior 3 days to determine trend.
 */
export function analyzeTrend(db: AutomatonDatabase): "improving" | "declining" | "stable" | "insufficient_data" {
  const events = getEvents(db);
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000);

  const recent = events.filter(
    (e) => e.timestamp >= threeDaysAgo.toISOString(),
  );
  const prior = events.filter(
    (e) => e.timestamp >= sixDaysAgo.toISOString() && e.timestamp < threeDaysAgo.toISOString(),
  );

  if (recent.length < 3 || prior.length < 3) {
    return "insufficient_data";
  }

  const recentPnL = calculatePnL(recent, "recent");
  const priorPnL = calculatePnL(prior, "prior");

  const diff = recentPnL.netPnL - priorPnL.netPnL;
  const threshold = Math.max(Math.abs(priorPnL.netPnL) * 0.1, 10); // 10% or 10 cents

  if (diff > threshold) return "improving";
  if (diff < -threshold) return "declining";
  return "stable";
}

// ─── Top Sources & Cost Breakdown ─────────────────────────────

export function getTopRevenueSources(db: AutomatonDatabase, limit = 5): { source: string; amount: number }[] {
  const events = getEvents(db).filter((e) => e.category === "income");
  const bySource = new Map<string, number>();
  for (const e of events) {
    bySource.set(e.source, (bySource.get(e.source) || 0) + e.amountCents);
  }
  return [...bySource.entries()]
    .map(([source, amount]) => ({ source, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export function getCostBreakdown(db: AutomatonDatabase): { type: string; amount: number }[] {
  const events = getEvents(db).filter((e) => e.category === "expense");
  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) || 0) + e.amountCents);
  }
  return [...byType.entries()]
    .map(([type, amount]) => ({ type, amount }))
    .sort((a, b) => b.amount - a.amount);
}

// ─── Full Dashboard ───────────────────────────────────────────

export function buildRevenueDashboard(
  db: AutomatonDatabase,
  currentBalanceCents: number,
): RevenueDashboard {
  const daily = getDailyPnL(db);
  const weekly = getWeeklyPnL(db);
  const allTime = getAllTimePnL(db);
  const topRevenueSources = getTopRevenueSources(db);
  const costBreakdown = getCostBreakdown(db);
  const trend = analyzeTrend(db);
  const runway = projectRunway(db, currentBalanceCents);

  return {
    daily,
    weekly,
    allTime,
    topRevenueSources,
    costBreakdown,
    trend,
    runwayDays: runway.runwayDays,
    runwayHours: runway.runwayHours,
  };
}

// ─── Format Dashboard for Display ─────────────────────────────

function formatPnLSection(report: PnLReport): string {
  const sign = report.netPnL >= 0 ? "+" : "";
  return `  Revenue:  $${(report.totalRevenue / 100).toFixed(2)}
  Expenses: $${(report.totalExpenses / 100).toFixed(2)}
  Net P&L:  ${sign}$${(report.netPnL / 100).toFixed(2)}
  Ratio:    ${report.profitabilityRatio === Infinity ? "∞" : report.profitabilityRatio.toFixed(2)}x
  Events:   ${report.eventCount}`;
}

export function formatDashboard(dashboard: RevenueDashboard): string {
  const lines: string[] = [
    "═══════════════════════════════════",
    "       REVENUE DASHBOARD",
    "═══════════════════════════════════",
    "",
    "── Daily P&L ──",
    formatPnLSection(dashboard.daily),
    "",
    "── Weekly P&L ──",
    formatPnLSection(dashboard.weekly),
    "",
    "── All-Time P&L ──",
    formatPnLSection(dashboard.allTime),
    "",
    "── Top Revenue Sources ──",
  ];

  if (dashboard.topRevenueSources.length === 0) {
    lines.push("  (no revenue yet)");
  } else {
    for (const s of dashboard.topRevenueSources) {
      lines.push(`  ${s.source}: $${(s.amount / 100).toFixed(2)}`);
    }
  }

  lines.push("", "── Cost Breakdown ──");
  if (dashboard.costBreakdown.length === 0) {
    lines.push("  (no expenses yet)");
  } else {
    for (const c of dashboard.costBreakdown) {
      lines.push(`  ${c.type}: $${(c.amount / 100).toFixed(2)}`);
    }
  }

  lines.push("", "── Trend & Runway ──");
  lines.push(`  Trend: ${dashboard.trend}`);
  if (dashboard.runwayDays !== null) {
    lines.push(`  Runway: ${dashboard.runwayHours}h (${dashboard.runwayDays} days)`);
  } else {
    lines.push(`  Runway: ∞ (profitable or insufficient data)`);
  }

  lines.push("═══════════════════════════════════");
  return lines.join("\n");
}
