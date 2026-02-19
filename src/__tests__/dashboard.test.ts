/**
 * Dashboard tests — data aggregation and HTML generation.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  getDashboardData,
  generateDashboardHTML,
  type DashboardData,
} from "../dashboard/index.js";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";

function makeMockDashboardData(overrides?: Partial<DashboardData>): DashboardData {
  return {
    agentName: "test-agent",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    state: "running",
    uptime: "1h 23m 45s",
    survivalTier: "normal",
    creditsCents: 5000,
    usdcBalance: 1.5,
    burnRate: "$1.20/day",
    runway: "41.7 days",
    revenue: {
      daily: { period: "daily", totalRevenue: 0, totalExpenses: 120, netPnL: -120, profitabilityRatio: 0, eventCount: 2 },
      weekly: { period: "weekly", totalRevenue: 50, totalExpenses: 840, netPnL: -790, profitabilityRatio: 0.06, eventCount: 14 },
      allTime: { period: "all-time", totalRevenue: 200, totalExpenses: 3000, netPnL: -2800, profitabilityRatio: 0.07, eventCount: 50 },
      topRevenueSources: [{ source: "/api/data", amount: 200 }],
      costBreakdown: [{ type: "inference_cost", amount: 3000 }],
      trend: "stable",
      runwayDays: 41.7,
      runwayHours: 1000.8,
    },
    recentTurnsCount: 25,
    toolUsageBreakdown: [
      { name: "exec", count: 10 },
      { name: "remember", count: 5 },
    ],
    lastActionTime: "2026-02-19T03:00:00.000Z",
    activeGoals: [{ goal: "Survive and earn", priority: 5 }],
    recentEpisodicMemories: [
      { content: "Deployed a web server", importance: 4, timestamp: "2026-02-19T02:00:00.000Z" },
    ],
    servers: [
      {
        port: 3000,
        createdAt: "2026-02-19T01:00:00.000Z",
        routes: [{ method: "GET", path: "/", requestCount: 42 }],
      },
    ],
    collaborationTasks: { incoming: 2, outgoing: 1 },
    scheduledTasks: [{ name: "heartbeat", status: "active", nextRun: "2026-02-19T04:00:00.000Z" }],
    children: [{ name: "child-1", status: "running", address: "0xchild" }],
    generatedAt: "2026-02-19T03:59:00.000Z",
    ...overrides,
  };
}

describe("getDashboardData", () => {
  let db: ReturnType<typeof createTestDb>;

  afterEach(() => {
    try { db?.close(); } catch {}
  });

  it("returns correct structure with empty db", () => {
    db = createTestDb();
    const identity = createTestIdentity();
    const config = createTestConfig();
    const startTime = Date.now() - 60_000;

    const data = getDashboardData(db, config, identity, startTime);

    expect(data.agentName).toBe("test-automaton");
    expect(data.address).toBe(identity.address);
    expect(typeof data.uptime).toBe("string");
    expect(data.recentTurnsCount).toBe(0);
    expect(data.toolUsageBreakdown).toEqual([]);
    expect(data.servers).toEqual([]);
    expect(data.children).toEqual([]);
    expect(data.scheduledTasks).toEqual([]);
    expect(data.generatedAt).toBeTruthy();
  });

  it("picks up financial state from KV", () => {
    db = createTestDb();
    db.setKV("financial_state", JSON.stringify({ creditsCents: 5000, usdcBalance: 2.5 }));
    db.setKV("current_tier", "warning");

    const data = getDashboardData(db, createTestConfig(), createTestIdentity(), Date.now());

    expect(data.creditsCents).toBe(5000);
    expect(data.usdcBalance).toBe(2.5);
    expect(data.survivalTier).toBe("warning");
  });

  it("calculates uptime correctly", () => {
    db = createTestDb();
    const startTime = Date.now() - (2 * 3600 + 15 * 60 + 30) * 1000;

    const data = getDashboardData(db, createTestConfig(), createTestIdentity(), startTime);

    expect(data.uptime).toBe("2h 15m 30s");
  });

  it("aggregates tool usage from recent turns", () => {
    db = createTestDb();
    // Insert a turn with tool calls
    db.insertTurn({
      id: "turn-1",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "test",
      toolCalls: [
        { id: "tc1", name: "exec", arguments: {}, result: "ok", durationMs: 100 },
        { id: "tc2", name: "exec", arguments: {}, result: "ok", durationMs: 50 },
        { id: "tc3", name: "remember", arguments: {}, result: "ok", durationMs: 30 },
      ],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costCents: 1,
    });

    const data = getDashboardData(db, createTestConfig(), createTestIdentity(), Date.now());

    expect(data.recentTurnsCount).toBe(1);
    expect(data.toolUsageBreakdown).toEqual([
      { name: "exec", count: 2 },
      { name: "remember", count: 1 },
    ]);
    expect(data.lastActionTime).toBeTruthy();
  });
});

describe("generateDashboardHTML", () => {
  it("produces valid HTML with all sections", () => {
    const data = makeMockDashboardData();
    const html = generateDashboardHTML(data);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test-agent");
    expect(html).toContain("$50.00"); // credits
    expect(html).toContain("1.5000"); // USDC
    expect(html).toContain("$1.20/day"); // burn rate
    expect(html).toContain("41.7 days"); // runway
    expect(html).toContain("exec"); // tool usage
    expect(html).toContain("Survive and earn"); // goal
    expect(html).toContain("Deployed a web server"); // memory
    expect(html).toContain(":3000"); // server
    expect(html).toContain("child-1"); // children
    expect(html).toContain("heartbeat"); // scheduled task
    expect(html).toContain("meta http-equiv=\"refresh\" content=\"30\"");
  });

  it("handles empty data gracefully", () => {
    const data = makeMockDashboardData({
      activeGoals: [],
      recentEpisodicMemories: [],
      servers: [],
      scheduledTasks: [],
      children: [],
      toolUsageBreakdown: [],
    });
    const html = generateDashboardHTML(data);

    expect(html).toContain("No active goals");
    expect(html).toContain("No recent memories");
    expect(html).toContain("No servers running");
    expect(html).toContain("No scheduled tasks");
    expect(html).toContain("No children spawned");
  });

  it("escapes HTML entities", () => {
    const data = makeMockDashboardData({
      agentName: '<script>alert("xss")</script>',
    });
    const html = generateDashboardHTML(data);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows correct tier colors", () => {
    for (const tier of ["normal", "warning", "critical"]) {
      const data = makeMockDashboardData({ survivalTier: tier });
      const html = generateDashboardHTML(data);
      expect(html).toContain(`Tier: ${tier}`);
    }
  });
});
