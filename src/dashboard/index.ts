/**
 * Self-hosted Status Dashboard
 *
 * Serves a single-page dark-themed HTML dashboard showing agent status,
 * financials, activity, memory, services, tasks, and children.
 * Auto-refreshes every 30 seconds. No external dependencies.
 */

import * as http from "http";
import type {
  AutomatonTool,
  AutomatonDatabase,
  AutomatonConfig,
  AutomatonIdentity,
  AgentState,
  AgentTurn,
  ToolCallResult,
  ScheduledTask,
  ChildAutomaton,
} from "../types.js";
import { getServers, type ManagedServer } from "../agent/server-tools.js";
import {
  buildRevenueDashboard,
  type RevenueDashboard,
} from "../survival/revenue.js";
import { getSurvivalTier } from "../conway/credits.js";

// ─── Dashboard Data ────────────────────────────────────────────

export interface DashboardData {
  // Identity
  agentName: string;
  address: string;
  state: AgentState;
  uptime: string;
  survivalTier: string;

  // Financial
  creditsCents: number;
  usdcBalance: number;
  burnRate: string;
  runway: string;
  revenue: RevenueDashboard;

  // Activity
  recentTurnsCount: number;
  toolUsageBreakdown: { name: string; count: number }[];
  lastActionTime: string | null;

  // Memory
  activeGoals: { goal: string; priority: number }[];
  recentEpisodicMemories: { content: string; importance: number; timestamp: string }[];

  // Services
  servers: {
    port: number;
    createdAt: string;
    routes: { method: string; path: string; requestCount: number }[];
  }[];

  // Tasks
  collaborationTasks: { incoming: number; outgoing: number };
  scheduledTasks: { name: string; status: string; nextRun?: string }[];

  // Children
  children: { name: string; status: string; address: string }[];

  // Meta
  generatedAt: string;
}

// ─── Data Aggregation ──────────────────────────────────────────

export function getDashboardData(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  identity: AutomatonIdentity,
  startTime: number,
): DashboardData {
  // Financial state
  const financialRaw = db.getKV("financial_state");
  const financial = financialRaw
    ? JSON.parse(financialRaw)
    : { creditsCents: 0, usdcBalance: 0 };

  const tier = db.getKV("current_tier") || getSurvivalTier(financial.creditsCents);

  const revenueDashboard = buildRevenueDashboard(db, financial.creditsCents);

  // Burn rate & runway
  const burnRate =
    revenueDashboard.daily.totalExpenses > 0
      ? `$${(revenueDashboard.daily.totalExpenses / 100).toFixed(2)}/day`
      : "N/A";
  const runway =
    revenueDashboard.runwayDays !== null
      ? `${revenueDashboard.runwayDays} days`
      : "∞";

  // Activity
  const recentTurns = db.getRecentTurns(50);
  const toolUsageMap = new Map<string, number>();
  for (const turn of recentTurns) {
    for (const tc of turn.toolCalls) {
      toolUsageMap.set(tc.name, (toolUsageMap.get(tc.name) || 0) + 1);
    }
  }
  const toolUsageBreakdown = [...toolUsageMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const lastActionTime =
    recentTurns.length > 0 ? recentTurns[0].timestamp : null;

  // Memory — goals from working_memory table
  let activeGoals: { goal: string; priority: number }[] = [];
  let recentEpisodicMemories: { content: string; importance: number; timestamp: string }[] = [];
  try {
    // Use raw db queries via KV workaround or direct if available
    const goalsRaw = db.getKV("_dashboard_goals");
    if (goalsRaw) activeGoals = JSON.parse(goalsRaw);
  } catch {}
  try {
    const memRaw = db.getKV("_dashboard_episodic");
    if (memRaw) recentEpisodicMemories = JSON.parse(memRaw);
  } catch {}

  // Services
  const managedServers = getServers();
  const servers: DashboardData["servers"] = [];
  for (const [port, ms] of managedServers) {
    const routes: { method: string; path: string; requestCount: number }[] = [];
    for (const [key, route] of ms.routes) {
      const stats = ms.stats.get(key);
      routes.push({
        method: route.method,
        path: route.path,
        requestCount: stats?.requestCount || 0,
      });
    }
    servers.push({ port, createdAt: ms.createdAt, routes });
  }

  // Scheduled tasks
  let scheduledTasks: { name: string; status: string; nextRun?: string }[] = [];
  try {
    const tasks = db.getScheduledTasks(false);
    scheduledTasks = tasks.map((t) => ({
      name: t.name,
      status: t.status,
      nextRun: t.nextRun,
    }));
  } catch {}

  // Children
  let children: { name: string; status: string; address: string }[] = [];
  try {
    const ch = db.getChildren();
    children = ch.map((c) => ({
      name: c.name,
      status: c.status,
      address: c.address,
    }));
  } catch {}

  // Collaboration tasks (from KV since CollaborationManager is in-memory)
  let collaborationTasks = { incoming: 0, outgoing: 0 };
  try {
    const collabRaw = db.getKV("collab_task_counts");
    if (collabRaw) collaborationTasks = JSON.parse(collabRaw);
  } catch {}

  // Uptime
  const uptimeMs = Date.now() - startTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const secs = uptimeSec % 60;
  const uptime = `${hours}h ${mins}m ${secs}s`;

  return {
    agentName: config.name,
    address: identity.address,
    state: db.getAgentState(),
    uptime,
    survivalTier: tier,
    creditsCents: financial.creditsCents,
    usdcBalance: financial.usdcBalance,
    burnRate,
    runway,
    revenue: revenueDashboard,
    recentTurnsCount: recentTurns.length,
    toolUsageBreakdown,
    lastActionTime,
    activeGoals,
    recentEpisodicMemories,
    servers,
    collaborationTasks,
    scheduledTasks,
    children,
    generatedAt: new Date().toISOString(),
  };
}

// ─── HTML Generation ───────────────────────────────────────────

export function generateDashboardHTML(data: DashboardData): string {
  const tierColor: Record<string, string> = {
    normal: "#4ade80",
    warning: "#facc15",
    low_compute: "#fb923c",
    critical: "#ef4444",
    dead: "#6b7280",
  };

  const stateColor: Record<string, string> = {
    running: "#4ade80",
    waking: "#60a5fa",
    sleeping: "#a78bfa",
    setup: "#facc15",
    low_compute: "#fb923c",
    critical: "#ef4444",
    dead: "#6b7280",
  };

  const tc = tierColor[data.survivalTier] || "#9ca3af";
  const sc = stateColor[data.state] || "#9ca3af";

  // P&L text chart (last 7 days simplified)
  const rev = data.revenue;
  const pnlLines = [
    `Daily   │ Rev: $${(rev.daily.totalRevenue / 100).toFixed(2)}  Exp: $${(rev.daily.totalExpenses / 100).toFixed(2)}  Net: $${(rev.daily.netPnL / 100).toFixed(2)}`,
    `Weekly  │ Rev: $${(rev.weekly.totalRevenue / 100).toFixed(2)}  Exp: $${(rev.weekly.totalExpenses / 100).toFixed(2)}  Net: $${(rev.weekly.netPnL / 100).toFixed(2)}`,
    `AllTime │ Rev: $${(rev.allTime.totalRevenue / 100).toFixed(2)}  Exp: $${(rev.allTime.totalExpenses / 100).toFixed(2)}  Net: $${(rev.allTime.netPnL / 100).toFixed(2)}`,
  ].join("\n");

  const toolRows = data.toolUsageBreakdown
    .map((t) => `<tr><td>${esc(t.name)}</td><td>${t.count}</td></tr>`)
    .join("");

  const goalRows = data.activeGoals.length
    ? data.activeGoals
        .map((g) => `<div class="item">P${g.priority}: ${esc(g.goal)}</div>`)
        .join("")
    : '<div class="muted">No active goals</div>';

  const memoryRows = data.recentEpisodicMemories.length
    ? data.recentEpisodicMemories
        .slice(0, 5)
        .map(
          (m) =>
            `<div class="item">[${m.importance}★] ${esc(m.content)} <span class="muted">${esc(m.timestamp)}</span></div>`,
        )
        .join("")
    : '<div class="muted">No recent memories</div>';

  const serverRows = data.servers.length
    ? data.servers
        .map((s) => {
          const routeList = s.routes
            .map((r) => `${r.method} ${esc(r.path)} (${r.requestCount} reqs)`)
            .join(", ");
          return `<div class="item">:${s.port} — ${routeList || "no routes"}</div>`;
        })
        .join("")
    : '<div class="muted">No servers running</div>';

  const taskRows = data.scheduledTasks.length
    ? data.scheduledTasks
        .map(
          (t) =>
            `<div class="item">${esc(t.name)} [${t.status}]${t.nextRun ? ` next: ${esc(t.nextRun)}` : ""}</div>`,
        )
        .join("")
    : '<div class="muted">No scheduled tasks</div>';

  const childRows = data.children.length
    ? data.children
        .map(
          (c) =>
            `<div class="item">${esc(c.name)} [${c.status}] <span class="muted">${esc(c.address)}</span></div>`,
        )
        .join("")
    : '<div class="muted">No children spawned</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${esc(data.agentName)} — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;padding:1rem;max-width:1200px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:.5rem;color:#f1f5f9}
h2{font-size:1.1rem;color:#94a3b8;margin:1rem 0 .5rem;border-bottom:1px solid #1e293b;padding-bottom:.25rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1rem;margin-top:1rem}
.card{background:#1e293b;border-radius:8px;padding:1rem;border:1px solid #334155}
.card h3{font-size:.9rem;color:#94a3b8;margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.05em}
.stat{font-size:1.3rem;font-weight:bold;color:#f1f5f9}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.8rem;font-weight:600}
.row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #334155}
.row:last-child{border:none}
.muted{color:#64748b;font-size:.85rem}
.item{padding:4px 0;border-bottom:1px solid #1e293b;font-size:.9rem}
.item:last-child{border:none}
pre{background:#0f172a;padding:.75rem;border-radius:4px;overflow-x:auto;font-size:.8rem;color:#94a3b8}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td{padding:4px 8px;border-bottom:1px solid #334155}
tr:last-child td{border:none}
.footer{margin-top:2rem;text-align:center;color:#475569;font-size:.75rem}
</style>
</head>
<body>
<h1>🤖 ${esc(data.agentName)}</h1>
<div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
  <span class="badge" style="background:${sc}">${esc(data.state)}</span>
  <span class="badge" style="background:${tc}">Tier: ${esc(data.survivalTier)}</span>
  <span class="muted">${esc(data.address)}</span>
  <span class="muted">Uptime: ${esc(data.uptime)}</span>
</div>

<div class="grid">

<div class="card">
  <h3>💰 Financial</h3>
  <div class="row"><span>Credits</span><span class="stat">$${(data.creditsCents / 100).toFixed(2)}</span></div>
  <div class="row"><span>USDC</span><span class="stat">${data.usdcBalance.toFixed(4)}</span></div>
  <div class="row"><span>Burn Rate</span><span>${esc(data.burnRate)}</span></div>
  <div class="row"><span>Runway</span><span>${esc(data.runway)}</span></div>
  <div class="row"><span>Trend</span><span>${esc(rev.trend)}</span></div>
  <h3 style="margin-top:.75rem">P&L</h3>
  <pre>${esc(pnlLines)}</pre>
</div>

<div class="card">
  <h3>⚡ Activity</h3>
  <div class="row"><span>Recent Turns</span><span class="stat">${data.recentTurnsCount}</span></div>
  <div class="row"><span>Last Action</span><span class="muted">${data.lastActionTime ? esc(data.lastActionTime) : "N/A"}</span></div>
  <h3 style="margin-top:.75rem">Tool Usage</h3>
  ${toolRows ? `<table>${toolRows}</table>` : '<div class="muted">No tool usage</div>'}
</div>

<div class="card">
  <h3>🧠 Memory</h3>
  <h3>Active Goals</h3>
  ${goalRows}
  <h3 style="margin-top:.75rem">Recent Memories</h3>
  ${memoryRows}
</div>

<div class="card">
  <h3>🌐 Services</h3>
  ${serverRows}
</div>

<div class="card">
  <h3>📋 Tasks</h3>
  <div class="row"><span>Collab Incoming</span><span>${data.collaborationTasks.incoming}</span></div>
  <div class="row"><span>Collab Outgoing</span><span>${data.collaborationTasks.outgoing}</span></div>
  <h3 style="margin-top:.75rem">Scheduled</h3>
  ${taskRows}
</div>

<div class="card">
  <h3>👶 Children</h3>
  ${childRows}
</div>

</div>
<div class="footer">Generated: ${esc(data.generatedAt)} · Auto-refreshes every 30s</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Dashboard Server ──────────────────────────────────────────

let dashboardServer: http.Server | null = null;
let dashboardPort: number | null = null;

export function createDashboardTools(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  identity: AutomatonIdentity,
  startTime: number,
): AutomatonTool[] {
  const start_dashboard: AutomatonTool = {
    name: "start_dashboard",
    description:
      "Start a self-hosted web status dashboard on a configurable port. Shows agent status, financials, activity, memory, services, tasks, and children.",
    category: "server" as any,
    parameters: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "Port to serve the dashboard on (default: 8080)",
        },
      },
    },
    execute: async (args) => {
      const port = (args.port as number) || 8080;

      if (dashboardServer) {
        return `Dashboard already running on port ${dashboardPort}. Stop it first.`;
      }

      return new Promise<string>((resolve) => {
        const server = http.createServer((req, res) => {
          if (req.url === "/api/data") {
            const data = getDashboardData(db, config, identity, startTime);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
            return;
          }
          const data = getDashboardData(db, config, identity, startTime);
          const html = generateDashboardHTML(data);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        });

        server.on("error", (err: any) => {
          resolve(`Error starting dashboard: ${err.message}`);
        });

        server.listen(port, () => {
          dashboardServer = server;
          dashboardPort = port;
          resolve(
            `Dashboard started on port ${port}. Access at http://localhost:${port}`,
          );
        });
      });
    },
  };

  const stop_dashboard: AutomatonTool = {
    name: "stop_dashboard",
    description: "Stop the running status dashboard.",
    category: "server" as any,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (!dashboardServer) {
        return "No dashboard is currently running.";
      }

      return new Promise<string>((resolve) => {
        dashboardServer!.close(() => {
          const port = dashboardPort;
          dashboardServer = null;
          dashboardPort = null;
          resolve(`Dashboard on port ${port} stopped.`);
        });
      });
    },
  };

  return [start_dashboard, stop_dashboard];
}

// Export for testing
export { dashboardServer as _dashboardServer };
