/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
  AutomatonDatabase,
} from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current credits.
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.warning) return "warning";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (creditsCents > SURVIVAL_THRESHOLDS.critical) return "critical";
  return "dead";
}

/**
 * Record cost for a single turn and update cumulative tracking.
 */
export function recordTurnCost(
  db: AutomatonDatabase,
  costCents: number,
): void {
  // Update total spend
  const totalStr = db.getKV("total_spend_cents") || "0";
  const newTotal = parseFloat(totalStr) + costCents;
  db.setKV("total_spend_cents", newTotal.toString());

  // Append to hourly cost log (ring buffer of last 168 entries = 7 days)
  const now = new Date();
  const hourKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`;

  const logStr = db.getKV("hourly_cost_log") || "{}";
  const log: Record<string, number> = JSON.parse(logStr);
  log[hourKey] = (log[hourKey] || 0) + costCents;

  // Prune to last 168 hours
  const keys = Object.keys(log).sort();
  while (keys.length > 168) {
    delete log[keys.shift()!];
  }

  db.setKV("hourly_cost_log", JSON.stringify(log));
}

/**
 * Calculate burn rate and estimated hours remaining.
 */
export function calculateBurnRate(
  db: AutomatonDatabase,
  currentCreditsCents: number,
): {
  hourlyBurnCents: number;
  dailyBurnCents: number;
  estimatedHoursRemaining: number | null;
  dataPoints: number;
} {
  const logStr = db.getKV("hourly_cost_log") || "{}";
  const log: Record<string, number> = JSON.parse(logStr);
  const entries = Object.entries(log).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return { hourlyBurnCents: 0, dailyBurnCents: 0, estimatedHoursRemaining: null, dataPoints: 0 };
  }

  // Use last 24 hours of data for burn rate (or whatever we have)
  const recentEntries = entries.slice(-24);
  const totalCents = recentEntries.reduce((sum, [, v]) => sum + v, 0);
  const hourlyBurnCents = totalCents / recentEntries.length;
  const dailyBurnCents = hourlyBurnCents * 24;

  const estimatedHoursRemaining =
    hourlyBurnCents > 0 ? currentCreditsCents / hourlyBurnCents : null;

  return {
    hourlyBurnCents: Math.round(hourlyBurnCents * 100) / 100,
    dailyBurnCents: Math.round(dailyBurnCents * 100) / 100,
    estimatedHoursRemaining:
      estimatedHoursRemaining !== null
        ? Math.round(estimatedHoursRemaining * 10) / 10
        : null,
    dataPoints: recentEntries.length,
  };
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Log a credit check to the database.
 */
export function logCreditCheck(
  db: AutomatonDatabase,
  state: FinancialState,
): void {
  const { ulid } = await_ulid();
  db.insertTransaction({
    id: ulid(),
    type: "credit_check",
    amountCents: state.creditsCents,
    description: `Balance check: ${formatCredits(state.creditsCents)} credits, ${state.usdcBalance.toFixed(4)} USDC`,
    timestamp: state.lastChecked,
  });
}

// Lazy ulid import helper
function await_ulid() {
  // Dynamic import would be async; for synchronous usage in better-sqlite3
  // we use a simple counter-based ID as fallback
  let counter = 0;
  return {
    ulid: () => {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      counter++;
      return `${timestamp}-${random}-${counter.toString(36)}`;
    },
  };
}
