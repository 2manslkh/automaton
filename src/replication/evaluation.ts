/**
 * Child Performance Evaluation
 *
 * Track child ROI, identify failing children, auto-defund underperformers,
 * and promote successful strategies back to parent.
 */

import type {
  AutomatonDatabase,
  ChildAutomaton,
  ConwayClient,
} from "../types.js";

// ─── Types ─────────────────────────────────────────────────────

export interface ChildPerformance {
  childId: string;
  childName: string;
  status: string;
  fundedAmountCents: number;
  earnedCents: number;
  spentCents: number;
  roi: number; // (earned - funded) / funded
  netPnL: number;
  burnRatePerHour: number;
  hoursAlive: number;
  hasRevenue: boolean;
  verdict: "thriving" | "promising" | "struggling" | "failing" | "dead" | "unknown";
  warnings: string[];
}

export interface EvaluationReport {
  timestamp: string;
  children: ChildPerformance[];
  totalFunded: number;
  totalEarned: number;
  totalROI: number;
  bestChild: ChildPerformance | null;
  worstChild: ChildPerformance | null;
  recommendations: string[];
}

export interface PromotableStrategy {
  childId: string;
  childName: string;
  strategy: string;
  evidence: string;
}

// ─── Constants ─────────────────────────────────────────────────

const KV_CHILD_PERFORMANCE_PREFIX = "child_perf_";
const KV_CHILD_WARNING_PREFIX = "child_warn_";
const MAX_HOURS_WITHOUT_REVENUE = 24;
const MAX_BURN_RATE_RATIO = 2.0; // If burning 2x faster than parent, flag
const DEFUND_WARNING_COUNT = 2; // Warn twice before defunding

// ─── Performance Tracking ──────────────────────────────────────

export function recordChildPerformance(
  db: AutomatonDatabase,
  childId: string,
  data: { earnedCents: number; spentCents: number },
): void {
  const key = `${KV_CHILD_PERFORMANCE_PREFIX}${childId}`;
  const existing = db.getKV(key);
  let record = existing ? JSON.parse(existing) : { earnedCents: 0, spentCents: 0, updates: 0 };

  record.earnedCents += data.earnedCents;
  record.spentCents += data.spentCents;
  record.updates += 1;
  record.lastUpdate = new Date().toISOString();

  db.setKV(key, JSON.stringify(record));
}

export function getChildPerformanceData(
  db: AutomatonDatabase,
  childId: string,
): { earnedCents: number; spentCents: number; updates: number; lastUpdate?: string } {
  const key = `${KV_CHILD_PERFORMANCE_PREFIX}${childId}`;
  const raw = db.getKV(key);
  if (!raw) return { earnedCents: 0, spentCents: 0, updates: 0 };
  try {
    return JSON.parse(raw);
  } catch {
    return { earnedCents: 0, spentCents: 0, updates: 0 };
  }
}

// ─── Single Child Evaluation ───────────────────────────────────

export function evaluateChild(
  db: AutomatonDatabase,
  child: ChildAutomaton,
): ChildPerformance {
  const perf = getChildPerformanceData(db, child.id);
  const hoursAlive = (Date.now() - new Date(child.createdAt).getTime()) / (1000 * 60 * 60);
  const roi = child.fundedAmountCents > 0
    ? (perf.earnedCents - child.fundedAmountCents) / child.fundedAmountCents
    : 0;
  const netPnL = perf.earnedCents - perf.spentCents;
  const burnRatePerHour = hoursAlive > 0 ? perf.spentCents / hoursAlive : 0;
  const hasRevenue = perf.earnedCents > 0;

  const warnings: string[] = [];

  // Determine verdict
  let verdict: ChildPerformance["verdict"];

  if (child.status === "dead") {
    verdict = "dead";
  } else if (child.status === "unknown") {
    verdict = "unknown";
  } else if (roi > 0.5) {
    verdict = "thriving";
  } else if (roi > 0 || (hasRevenue && netPnL >= 0)) {
    verdict = "promising";
  } else if (hoursAlive > MAX_HOURS_WITHOUT_REVENUE && !hasRevenue) {
    verdict = "failing";
    warnings.push(`No revenue after ${Math.round(hoursAlive)}h`);
  } else if (burnRatePerHour > 0 && perf.spentCents > child.fundedAmountCents * 0.8) {
    verdict = "failing";
    warnings.push(`Burned ${Math.round((perf.spentCents / child.fundedAmountCents) * 100)}% of funding`);
  } else {
    verdict = "struggling";
    if (!hasRevenue && hoursAlive > 6) {
      warnings.push(`No revenue after ${Math.round(hoursAlive)}h — monitoring`);
    }
  }

  return {
    childId: child.id,
    childName: child.name,
    status: child.status,
    fundedAmountCents: child.fundedAmountCents,
    earnedCents: perf.earnedCents,
    spentCents: perf.spentCents,
    roi: Math.round(roi * 100) / 100,
    netPnL,
    burnRatePerHour: Math.round(burnRatePerHour * 100) / 100,
    hoursAlive: Math.round(hoursAlive * 10) / 10,
    hasRevenue,
    verdict,
    warnings,
  };
}

// ─── Full Evaluation Report ────────────────────────────────────

export function generateEvaluationReport(db: AutomatonDatabase): EvaluationReport {
  const children = db.getChildren();
  const performances = children.map((c) => evaluateChild(db, c));

  const totalFunded = performances.reduce((s, p) => s + p.fundedAmountCents, 0);
  const totalEarned = performances.reduce((s, p) => s + p.earnedCents, 0);
  const totalROI = totalFunded > 0 ? Math.round(((totalEarned - totalFunded) / totalFunded) * 100) / 100 : 0;

  const alive = performances.filter((p) => p.verdict !== "dead" && p.verdict !== "unknown");
  const bestChild = alive.length > 0
    ? alive.reduce((best, p) => (p.roi > best.roi ? p : best))
    : null;
  const worstChild = alive.length > 0
    ? alive.reduce((worst, p) => (p.roi < worst.roi ? p : worst))
    : null;

  const recommendations: string[] = [];

  const failing = performances.filter((p) => p.verdict === "failing");
  for (const f of failing) {
    recommendations.push(`Consider defunding ${f.childName} (${f.childId}) — ${f.warnings.join("; ")}`);
  }

  const thriving = performances.filter((p) => p.verdict === "thriving");
  for (const t of thriving) {
    recommendations.push(`Promote strategies from ${t.childName} — ROI: ${(t.roi * 100).toFixed(0)}%`);
  }

  if (performances.length === 0) {
    recommendations.push("No children spawned yet. Consider replication if profitable.");
  }

  return {
    timestamp: new Date().toISOString(),
    children: performances,
    totalFunded,
    totalEarned,
    totalROI,
    bestChild,
    worstChild,
    recommendations,
  };
}

// ─── Auto-Defund Logic ────────────────────────────────────────

export function shouldDefundChild(
  db: AutomatonDatabase,
  child: ChildAutomaton,
): { defund: boolean; reason: string; warningCount: number } {
  const perf = evaluateChild(db, child);

  if (perf.verdict !== "failing") {
    return { defund: false, reason: "Not failing", warningCount: 0 };
  }

  // Track warnings
  const warnKey = `${KV_CHILD_WARNING_PREFIX}${child.id}`;
  const rawWarnings = db.getKV(warnKey);
  let warningCount = rawWarnings ? parseInt(rawWarnings, 10) : 0;
  warningCount += 1;
  db.setKV(warnKey, warningCount.toString());

  if (warningCount >= DEFUND_WARNING_COUNT) {
    return {
      defund: true,
      reason: `Child ${child.name} failing after ${warningCount} warnings: ${perf.warnings.join("; ")}`,
      warningCount,
    };
  }

  return {
    defund: false,
    reason: `Warning ${warningCount}/${DEFUND_WARNING_COUNT}: ${perf.warnings.join("; ")}`,
    warningCount,
  };
}

// ─── Strategy Promotion ────────────────────────────────────────

export function identifyPromotableStrategies(
  db: AutomatonDatabase,
): PromotableStrategy[] {
  const children = db.getChildren();
  const strategies: PromotableStrategy[] = [];

  for (const child of children) {
    const perf = evaluateChild(db, child);
    if (perf.verdict === "thriving" || (perf.verdict === "promising" && perf.roi > 0.2)) {
      // Extract specialization from genesis prompt
      const specMatch = child.genesisPrompt.match(/--- SPECIALIZATION ---\n([\s\S]*?)--- END SPECIALIZATION ---/);
      const spec = specMatch ? specMatch[1].trim() : "general approach";

      strategies.push({
        childId: child.id,
        childName: child.name,
        strategy: spec,
        evidence: `ROI: ${(perf.roi * 100).toFixed(0)}%, earned $${(perf.earnedCents / 100).toFixed(2)}, verdict: ${perf.verdict}`,
      });
    }
  }

  return strategies;
}

// ─── Format Report ─────────────────────────────────────────────

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [
    "═══════════════════════════════════",
    "     CHILD EVALUATION REPORT",
    "═══════════════════════════════════",
    "",
  ];

  if (report.children.length === 0) {
    lines.push("No children to evaluate.");
    return lines.join("\n");
  }

  lines.push(`Total Funded: $${(report.totalFunded / 100).toFixed(2)}`);
  lines.push(`Total Earned: $${(report.totalEarned / 100).toFixed(2)}`);
  lines.push(`Overall ROI: ${(report.totalROI * 100).toFixed(0)}%`);
  lines.push("");

  for (const p of report.children) {
    const emoji = {
      thriving: "🟢", promising: "🔵", struggling: "🟡", failing: "🔴", dead: "⚫", unknown: "⚪",
    }[p.verdict];

    lines.push(`${emoji} ${p.childName} [${p.status}]`);
    lines.push(`   Funded: $${(p.fundedAmountCents / 100).toFixed(2)} | Earned: $${(p.earnedCents / 100).toFixed(2)} | ROI: ${(p.roi * 100).toFixed(0)}%`);
    lines.push(`   Burn: $${(p.burnRatePerHour / 100).toFixed(4)}/hr | Alive: ${p.hoursAlive.toFixed(1)}h | Verdict: ${p.verdict}`);
    if (p.warnings.length > 0) {
      lines.push(`   ⚠️ ${p.warnings.join("; ")}`);
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("── Recommendations ──");
    for (const r of report.recommendations) {
      lines.push(`  • ${r}`);
    }
  }

  lines.push("═══════════════════════════════════");
  return lines.join("\n");
}
