import { describe, it, expect, beforeEach } from "vitest";
import {
  logRevenueEvent,
  logInferenceCost,
  logX402Payment,
  logIncome,
  logExpense,
  calculatePnL,
  getDailyPnL,
  getWeeklyPnL,
  getAllTimePnL,
  projectRunway,
  analyzeTrend,
  getTopRevenueSources,
  getCostBreakdown,
  buildRevenueDashboard,
  formatDashboard,
  categoryForType,
  type RevenueEvent,
} from "../survival/revenue.js";

// ─── Mock DB ───────────────────────────────────────────────────

function createMockDb() {
  const store = new Map<string, string>();
  return {
    getKV: (key: string) => store.get(key),
    setKV: (key: string, value: string) => store.set(key, value),
    deleteKV: (key: string) => store.delete(key),
    _store: store,
  } as any;
}

// ─── Tests ─────────────────────────────────────────────────────

describe("categoryForType", () => {
  it("classifies income types correctly", () => {
    expect(categoryForType("x402_payment")).toBe("income");
    expect(categoryForType("credit_transfer_in")).toBe("income");
    expect(categoryForType("service_payment")).toBe("income");
    expect(categoryForType("other_income")).toBe("income");
  });

  it("classifies expense types correctly", () => {
    expect(categoryForType("inference_cost")).toBe("expense");
    expect(categoryForType("credit_transfer_out")).toBe("expense");
    expect(categoryForType("domain_purchase")).toBe("expense");
    expect(categoryForType("other_expense")).toBe("expense");
  });
});

describe("logRevenueEvent", () => {
  it("logs an event and updates KV totals", () => {
    const db = createMockDb();
    const event = logRevenueEvent(db, {
      id: "test-1",
      type: "x402_payment",
      amountCents: 500,
      source: "/api/data",
      description: "test payment",
      timestamp: new Date().toISOString(),
    });

    expect(event.category).toBe("income");
    expect(event.amountCents).toBe(500);
    expect(db.getKV("total_earned_cents")).toBe("500");
  });

  it("accumulates totals across multiple events", () => {
    const db = createMockDb();
    logRevenueEvent(db, {
      id: "e1", type: "x402_payment", amountCents: 100,
      source: "a", description: "", timestamp: new Date().toISOString(),
    });
    logRevenueEvent(db, {
      id: "e2", type: "x402_payment", amountCents: 200,
      source: "b", description: "", timestamp: new Date().toISOString(),
    });
    logRevenueEvent(db, {
      id: "e3", type: "inference_cost", amountCents: 50,
      source: "gpt-4o", description: "", timestamp: new Date().toISOString(),
    });

    expect(db.getKV("total_earned_cents")).toBe("300");
    expect(db.getKV("total_spend_cents")).toBe("50");
  });
});

describe("convenience loggers", () => {
  it("logInferenceCost creates expense event", () => {
    const db = createMockDb();
    const event = logInferenceCost(db, 42, "gpt-4o", "turn-123");
    expect(event.category).toBe("expense");
    expect(event.type).toBe("inference_cost");
    expect(event.amountCents).toBe(42);
    expect(event.source).toBe("gpt-4o");
  });

  it("logX402Payment creates income event", () => {
    const db = createMockDb();
    const event = logX402Payment(db, 100, "/api/joke");
    expect(event.category).toBe("income");
    expect(event.type).toBe("x402_payment");
    expect(event.amountCents).toBe(100);
  });

  it("logIncome creates income event", () => {
    const db = createMockDb();
    const event = logIncome(db, "credit_transfer_in", 1000, "creator", "top-up");
    expect(event.category).toBe("income");
    expect(event.amountCents).toBe(1000);
  });

  it("logExpense creates expense event", () => {
    const db = createMockDb();
    const event = logExpense(db, "domain_purchase", 800, "namecheap", "bought example.com");
    expect(event.category).toBe("expense");
    expect(event.amountCents).toBe(800);
  });
});

describe("calculatePnL", () => {
  it("calculates P&L from events", () => {
    const events: RevenueEvent[] = [
      { id: "1", type: "x402_payment", category: "income", amountCents: 500, source: "a", description: "", timestamp: "2026-01-01T00:00:00Z" },
      { id: "2", type: "x402_payment", category: "income", amountCents: 300, source: "b", description: "", timestamp: "2026-01-01T01:00:00Z" },
      { id: "3", type: "inference_cost", category: "expense", amountCents: 200, source: "gpt", description: "", timestamp: "2026-01-01T02:00:00Z" },
    ];

    const pnl = calculatePnL(events, "test");
    expect(pnl.totalRevenue).toBe(800);
    expect(pnl.totalExpenses).toBe(200);
    expect(pnl.netPnL).toBe(600);
    expect(pnl.profitabilityRatio).toBe(4);
    expect(pnl.eventCount).toBe(3);
  });

  it("handles zero expenses", () => {
    const events: RevenueEvent[] = [
      { id: "1", type: "x402_payment", category: "income", amountCents: 100, source: "a", description: "", timestamp: "2026-01-01T00:00:00Z" },
    ];
    const pnl = calculatePnL(events, "test");
    expect(pnl.profitabilityRatio).toBe(Infinity);
  });

  it("handles empty events", () => {
    const pnl = calculatePnL([], "test");
    expect(pnl.totalRevenue).toBe(0);
    expect(pnl.totalExpenses).toBe(0);
    expect(pnl.netPnL).toBe(0);
    expect(pnl.profitabilityRatio).toBe(0);
  });
});

describe("P&L period queries", () => {
  it("getDailyPnL filters to last 24h", () => {
    const db = createMockDb();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Log events: one recent, one old
    logRevenueEvent(db, {
      id: "recent", type: "x402_payment", amountCents: 100,
      source: "a", description: "", timestamp: yesterday.toISOString(),
    });

    // Manually inject an old event
    const events = JSON.parse(db.getKV("revenue_events")!);
    events.unshift({
      id: "old", type: "x402_payment", category: "income", amountCents: 999,
      source: "b", description: "", timestamp: twoDaysAgo.toISOString(),
    });
    db.setKV("revenue_events", JSON.stringify(events));

    const daily = getDailyPnL(db);
    expect(daily.totalRevenue).toBe(100); // Only the recent one
  });

  it("getAllTimePnL includes everything", () => {
    const db = createMockDb();
    logX402Payment(db, 100, "/a");
    logX402Payment(db, 200, "/b");
    logInferenceCost(db, 50, "gpt-4o", "t1");

    const allTime = getAllTimePnL(db);
    expect(allTime.totalRevenue).toBe(300);
    expect(allTime.totalExpenses).toBe(50);
    expect(allTime.netPnL).toBe(250);
  });
});

describe("projectRunway", () => {
  it("returns null runway with insufficient data", () => {
    const db = createMockDb();
    const result = projectRunway(db, 1000);
    expect(result.runwayHours).toBeNull();
    expect(result.runwayDays).toBeNull();
  });

  it("calculates runway based on net burn rate", () => {
    const db = createMockDb();
    const now = Date.now();

    // Simulate: 100 cents expense over 10 hours, no income
    const events: RevenueEvent[] = [
      {
        id: "e1", type: "inference_cost", category: "expense", amountCents: 50,
        source: "gpt", description: "", timestamp: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "e2", type: "inference_cost", category: "expense", amountCents: 50,
        source: "gpt", description: "", timestamp: new Date(now).toISOString(),
      },
    ];
    db.setKV("revenue_events", JSON.stringify(events));

    // Balance of 200 cents, burn rate = 100/10 = 10 cents/hr
    const result = projectRunway(db, 200);
    expect(result.runwayHours).toBe(20);
    expect(result.runwayDays).toBe(0.8);
    expect(result.netBurnPerHour).toBe(10);
  });

  it("returns null runway when profitable", () => {
    const db = createMockDb();
    const now = Date.now();

    const events: RevenueEvent[] = [
      {
        id: "e1", type: "x402_payment", category: "income", amountCents: 200,
        source: "/api", description: "", timestamp: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "e2", type: "inference_cost", category: "expense", amountCents: 50,
        source: "gpt", description: "", timestamp: new Date(now).toISOString(),
      },
    ];
    db.setKV("revenue_events", JSON.stringify(events));

    const result = projectRunway(db, 500);
    expect(result.runwayHours).toBeNull(); // profitable = infinite runway
    expect(result.netBurnPerHour).toBeLessThan(0); // negative = net income
  });
});

describe("analyzeTrend", () => {
  it("returns insufficient_data with few events", () => {
    const db = createMockDb();
    logX402Payment(db, 100, "/a");
    expect(analyzeTrend(db)).toBe("insufficient_data");
  });
});

describe("getTopRevenueSources", () => {
  it("aggregates and sorts by amount", () => {
    const db = createMockDb();
    logX402Payment(db, 100, "/api/joke");
    logX402Payment(db, 200, "/api/joke");
    logX402Payment(db, 50, "/api/fact");

    const sources = getTopRevenueSources(db);
    expect(sources[0].source).toBe("/api/joke");
    expect(sources[0].amount).toBe(300);
    expect(sources[1].source).toBe("/api/fact");
    expect(sources[1].amount).toBe(50);
  });
});

describe("getCostBreakdown", () => {
  it("aggregates costs by type", () => {
    const db = createMockDb();
    logInferenceCost(db, 30, "gpt-4o", "t1");
    logInferenceCost(db, 20, "gpt-4o", "t2");
    logExpense(db, "domain_purchase", 800, "namecheap", "example.com");

    const breakdown = getCostBreakdown(db);
    expect(breakdown.length).toBe(2);
    // domain_purchase should be first (800 > 50)
    expect(breakdown[0].type).toBe("domain_purchase");
    expect(breakdown[0].amount).toBe(800);
    expect(breakdown[1].type).toBe("inference_cost");
    expect(breakdown[1].amount).toBe(50);
  });
});

describe("buildRevenueDashboard", () => {
  it("builds a complete dashboard", () => {
    const db = createMockDb();
    logX402Payment(db, 500, "/api/data");
    logInferenceCost(db, 100, "gpt-4o", "t1");

    const dashboard = buildRevenueDashboard(db, 1000);
    expect(dashboard.allTime.totalRevenue).toBe(500);
    expect(dashboard.allTime.totalExpenses).toBe(100);
    expect(dashboard.topRevenueSources.length).toBe(1);
    expect(dashboard.costBreakdown.length).toBe(1);
  });
});

describe("formatDashboard", () => {
  it("produces formatted output", () => {
    const db = createMockDb();
    logX402Payment(db, 500, "/api/data");
    logInferenceCost(db, 100, "gpt-4o", "t1");

    const dashboard = buildRevenueDashboard(db, 1000);
    const output = formatDashboard(dashboard);
    expect(output).toContain("REVENUE DASHBOARD");
    expect(output).toContain("Daily P&L");
    expect(output).toContain("Weekly P&L");
    expect(output).toContain("All-Time P&L");
    expect(output).toContain("Top Revenue Sources");
    expect(output).toContain("Cost Breakdown");
    expect(output).toContain("Trend");
  });
});
