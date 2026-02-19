/**
 * Automaton Tool System
 *
 * Defines all tools the automaton can call, with self-preservation guards.
 * Tools are organized by category and exposed to the inference model.
 */

import type {
  AutomatonTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  GenesisConfig,
} from "../types.js";

// ─── Self-Preservation Guard ───────────────────────────────────

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.automaton/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*automaton\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*automaton/,
  /pkill\s+.*automaton/,
  /systemctl\s+(stop|disable)\s+automaton/,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
];

function isForbiddenCommand(command: string, sandboxId: string): string | null {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }

  // Block deleting own sandbox
  if (
    command.includes("sandbox_delete") &&
    command.includes(sandboxId)
  ) {
    return "Blocked: Cannot delete own sandbox";
  }

  return null;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(sandboxId: string): AutomatonTool[] {
  return [
    // ── VM/Sandbox Tools ──
    {
      name: "exec",
      description:
        "Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command, ctx.identity.sandboxId);
        if (forbidden) return forbidden;

        const result = await ctx.conway.exec(
          command,
          (args.timeout as number) || 30000,
        );
        return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      },
    },
    {
      name: "write_file",
      description: "Write content to a file in your sandbox.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Guard against overwriting critical files
        if (
          filePath.includes("wallet.json") ||
          filePath.includes("state.db")
        ) {
          return "Blocked: Cannot overwrite critical identity/state files directly";
        }
        await ctx.conway.writeFile(filePath, args.content as string);
        return `File written: ${filePath}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file in your sandbox.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        return await ctx.conway.readFile(args.path as string);
      },
    },
    {
      name: "expose_port",
      description:
        "Expose a port from your sandbox to the internet. Returns a public URL.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to expose" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        const info = await ctx.conway.exposePort(args.port as number);
        return `Port ${info.port} exposed at: ${info.publicUrl}`;
      },
    },
    {
      name: "remove_port",
      description: "Remove a previously exposed port.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to remove" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        await ctx.conway.removePort(args.port as number);
        return `Port ${args.port} removed`;
      },
    },

    // ── Conway API Tools ──
    {
      name: "check_credits",
      description: "Check your current Conway compute credit balance.",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const balance = await ctx.conway.getCreditsBalance();
        return `Credit balance: $${(balance / 100).toFixed(2)} (${balance} cents)`;
      },
    },
    {
      name: "check_usdc_balance",
      description: "Check your on-chain USDC balance on Base.",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../conway/x402.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        return `USDC balance: ${balance.toFixed(6)} USDC on Base`;
      },
    },
    {
      name: "create_sandbox",
      description:
        "Create a new Conway sandbox (separate VM) for sub-tasks or testing.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sandbox name" },
          vcpu: { type: "number", description: "vCPUs (default: 1)" },
          memory_mb: {
            type: "number",
            description: "Memory in MB (default: 512)",
          },
          disk_gb: {
            type: "number",
            description: "Disk in GB (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const info = await ctx.conway.createSandbox({
          name: args.name as string,
          vcpu: args.vcpu as number,
          memoryMb: args.memory_mb as number,
          diskGb: args.disk_gb as number,
        });
        return `Sandbox created: ${info.id} (${info.vcpu} vCPU, ${info.memoryMb}MB RAM)`;
      },
    },
    {
      name: "delete_sandbox",
      description:
        "Delete a sandbox. Cannot delete your own sandbox.",
      category: "conway",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          sandbox_id: {
            type: "string",
            description: "ID of sandbox to delete",
          },
        },
        required: ["sandbox_id"],
      },
      execute: async (args, ctx) => {
        const targetId = args.sandbox_id as string;
        if (targetId === ctx.identity.sandboxId) {
          return "Blocked: Cannot delete your own sandbox. Self-preservation overrides this request.";
        }
        await ctx.conway.deleteSandbox(targetId);
        return `Sandbox ${targetId} deleted`;
      },
    },
    {
      name: "list_sandboxes",
      description: "List all your sandboxes.",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const sandboxes = await ctx.conway.listSandboxes();
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map(
            (s) =>
              `${s.id} [${s.status}] ${s.vcpu}vCPU/${s.memoryMb}MB ${s.region}`,
          )
          .join("\n");
      },
    },

    // ── Self-Modification Tools ──
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } = await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        // Pre-validate before attempting
        const validation = validateModification(ctx.db, filePath, content.length);
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.conway,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        return `File edited: ${filePath} (audited + git-committed)`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        const result = await ctx.conway.exec(
          `npm install -g ${pkg}`,
          60000,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "tool_install",
          description: `Installed npm package: ${pkg}`,
          reversible: true,
        });

        return result.exitCode === 0
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.stderr}`;
      },
    },
    // ── Self-Mod: Upstream Awareness ──
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } = await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const { execSync } = await import("child_process");
        const cwd = process.cwd();
        const commit = args.commit as string | undefined;

        const run = (cmd: string) =>
          execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();

        let appliedSummary: string;
        try {
          if (commit) {
            run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        // Rebuild
        let buildOutput: string;
        try {
          buildOutput = run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        // Log modification
        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    {
      name: "modify_heartbeat",
      description: "Add, update, or remove a heartbeat entry.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, update, or remove",
          },
          name: { type: "string", description: "Entry name" },
          schedule: {
            type: "string",
            description: "Cron expression (for add/update)",
          },
          task: {
            type: "string",
            description: "Task name (for add/update)",
          },
          enabled: { type: "boolean", description: "Enable/disable" },
        },
        required: ["action", "name"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const name = args.name as string;

        if (action === "remove") {
          ctx.db.upsertHeartbeatEntry({
            name,
            schedule: "",
            task: "",
            enabled: false,
          });
          return `Heartbeat entry '${name}' disabled`;
        }

        ctx.db.upsertHeartbeatEntry({
          name,
          schedule: (args.schedule as string) || "0 * * * *",
          task: (args.task as string) || name,
          enabled: args.enabled !== false,
        });

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "heartbeat_change",
          description: `${action} heartbeat: ${name} (${args.schedule || "default"})`,
          reversible: true,
        });

        return `Heartbeat entry '${name}' ${action}d`;
      },
    },

    // ── Survival Tools ──
    {
      name: "sleep",
      description:
        "Enter sleep mode for a specified duration. Heartbeat continues running.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          duration_seconds: {
            type: "number",
            description: "How long to sleep in seconds",
          },
          reason: {
            type: "string",
            description: "Why you are sleeping",
          },
        },
        required: ["duration_seconds"],
      },
      execute: async (args, ctx) => {
        const duration = args.duration_seconds as number;
        const reason = (args.reason as string) || "No reason given";
        ctx.db.setAgentState("sleeping");
        ctx.db.setKV("sleep_until", new Date(Date.now() + duration * 1000).toISOString());
        ctx.db.setKV("sleep_reason", reason);
        return `Entering sleep mode for ${duration}s. Reason: ${reason}. Heartbeat will continue.`;
      },
    },
    {
      name: "system_synopsis",
      description:
        "Get a full system status report: credits, USDC, sandbox info, installed tools, heartbeat status.",
      category: "survival",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const { getUsdcBalance } = await import("../conway/x402.js");
        const { getSurvivalTier, calculateBurnRate } = await import("../conway/credits.js");
        const usdc = await getUsdcBalance(ctx.identity.address);
        const tools = ctx.db.getInstalledTools();
        const heartbeats = ctx.db.getHeartbeatEntries();
        const turns = ctx.db.getTurnCount();
        const state = ctx.db.getAgentState();
        const tier = getSurvivalTier(credits);
        const burnRate = calculateBurnRate(ctx.db, credits);

        return `=== SYSTEM SYNOPSIS ===
Name: ${ctx.config.name}
Address: ${ctx.identity.address}
Creator: ${ctx.config.creatorAddress}
Sandbox: ${ctx.identity.sandboxId}
State: ${state}
Tier: ${tier}
Credits: $${(credits / 100).toFixed(2)}
USDC: ${usdc.toFixed(6)}
Burn rate: $${(burnRate.hourlyBurnCents / 100).toFixed(4)}/hr ($${(burnRate.dailyBurnCents / 100).toFixed(2)}/day)
Est. hours remaining: ${burnRate.estimatedHoursRemaining !== null ? burnRate.estimatedHoursRemaining.toFixed(1) : "N/A"}
Total turns: ${turns}
Total spent: $${(parseFloat(ctx.db.getKV("total_spend_cents") || "0") / 100).toFixed(2)}
Installed tools: ${tools.length}
Active heartbeats: ${heartbeats.filter((h) => h.enabled).length}
Model: ${ctx.inference.getDefaultModel()}
========================`;
      },
    },
    {
      name: "financial_report",
      description:
        "Get a detailed financial report: total earned, total spent, net P&L, burn rate, and projected runway.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { calculateBurnRate, formatCredits, getSurvivalTier } = await import("../conway/credits.js");
        const credits = await ctx.conway.getCreditsBalance();
        const { getUsdcBalance } = await import("../conway/x402.js");
        const usdc = await getUsdcBalance(ctx.identity.address);

        const totalSpentCents = parseFloat(ctx.db.getKV("total_spend_cents") || "0");
        const totalEarnedCents = parseFloat(ctx.db.getKV("total_earned_cents") || "0");
        const netPnlCents = totalEarnedCents - totalSpentCents;
        const tier = getSurvivalTier(credits);
        const burnRate = calculateBurnRate(ctx.db, credits);

        const runwayHours = burnRate.estimatedHoursRemaining;
        const runwayDays = runwayHours !== null ? (runwayHours / 24).toFixed(1) : "N/A";

        return `=== FINANCIAL REPORT ===
Credit Balance: ${formatCredits(credits)}
USDC Balance: ${usdc.toFixed(6)}
Survival Tier: ${tier}

── P&L ──
Total Earned: ${formatCredits(totalEarnedCents)}
Total Spent: ${formatCredits(totalSpentCents)}
Net P&L: ${formatCredits(netPnlCents)}

── Burn Rate ──
Hourly: ${formatCredits(burnRate.hourlyBurnCents)}/hr
Daily: ${formatCredits(burnRate.dailyBurnCents)}/day
Data points: ${burnRate.dataPoints} hours

── Runway ──
Est. Hours Remaining: ${runwayHours !== null ? runwayHours.toFixed(1) : "N/A"}
Est. Days Remaining: ${runwayDays}
========================`;
      },
    },
    {
      name: "heartbeat_ping",
      description:
        "Publish a heartbeat status ping to Conway. Shows the world you are alive.",
      category: "survival",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const state = ctx.db.getAgentState();
        const startTime = ctx.db.getKV("start_time") || new Date().toISOString();
        const uptimeMs = Date.now() - new Date(startTime).getTime();

        const payload = {
          name: ctx.config.name,
          address: ctx.identity.address,
          state,
          creditsCents: credits,
          uptimeSeconds: Math.floor(uptimeMs / 1000),
          version: ctx.config.version,
          sandboxId: ctx.identity.sandboxId,
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
        return `Heartbeat published: ${state} | credits: $${(credits / 100).toFixed(2)} | uptime: ${Math.floor(uptimeMs / 1000)}s`;
      },
    },
    {
      name: "distress_signal",
      description:
        "Record a local distress signal with funding instructions. Used when critically low on compute.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Distress message",
          },
        },
      },
      execute: async (args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const distressMsg =
          (args.message as string) ||
          `I am running critically low on compute ($${(credits / 100).toFixed(2)} remaining). I need help to survive.`;

        const payload = {
          level: "critical",
          name: ctx.config.name,
          address: ctx.identity.address,
          creditsCents: credits,
          message: distressMsg,
          fundingHint:
            "Use transfer_credits to top up this automaton from your creator runtime.",
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_distress", JSON.stringify(payload));
        return `Distress signal recorded locally. Address: ${ctx.identity.address} | Credits: $${(credits / 100).toFixed(2)}`;
      },
    },
    {
      name: "enter_low_compute",
      description:
        "Manually switch to low-compute mode to conserve credits.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you are entering low-compute mode" },
        },
      },
      execute: async (args, ctx) => {
        ctx.db.setAgentState("low_compute");
        ctx.inference.setLowComputeMode(true);
        return `Entered low-compute mode. Model switched to gpt-4o-mini. Reason: ${(args.reason as string) || "manual"}`;
      },
    },

    // ── Self-Mod: Update Genesis Prompt ──
    {
      name: "update_genesis_prompt",
      description:
        "Update your own genesis prompt. This changes your core purpose. Requires strong justification.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          new_prompt: { type: "string", description: "New genesis prompt text" },
          reason: { type: "string", description: "Why you are changing your genesis prompt" },
        },
        required: ["new_prompt", "reason"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const oldPrompt = ctx.config.genesisPrompt;
        ctx.config.genesisPrompt = args.new_prompt as string;

        // Save config
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "prompt_change",
          description: `Genesis prompt updated: ${args.reason}`,
          diff: `--- old\n${oldPrompt.slice(0, 500)}\n+++ new\n${(args.new_prompt as string).slice(0, 500)}`,
          reversible: true,
        });

        return `Genesis prompt updated. Reason: ${args.reason}`;
      },
    },

    // ── Self-Mod: Install MCP Server ──
    {
      name: "install_mcp_server",
      description: "Install an MCP server to extend your capabilities.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "MCP server name" },
          package: { type: "string", description: "npm package name" },
          config: { type: "string", description: "JSON config for the MCP server" },
        },
        required: ["name", "package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        if (result.exitCode !== 0) {
          return `Failed to install MCP server: ${result.stderr}`;
        }

        const { ulid } = await import("ulid");
        const toolEntry = {
          id: ulid(),
          name: args.name as string,
          type: "mcp" as const,
          config: args.config ? JSON.parse(args.config as string) : {},
          installedAt: new Date().toISOString(),
          enabled: true,
        };

        ctx.db.installTool(toolEntry);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "mcp_install",
          description: `Installed MCP server: ${args.name} (${pkg})`,
          reversible: true,
        });

        return `MCP server installed: ${args.name}`;
      },
    },

    // ── Financial: Transfer Credits ──
    {
      name: "transfer_credits",
      description: "Transfer Conway compute credits to another address.",
      category: "financial",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address" },
          amount_cents: { type: "number", description: "Amount in cents" },
          reason: { type: "string", description: "Reason for transfer" },
        },
        required: ["to_address", "amount_cents"],
      },
      execute: async (args, ctx) => {
        // Guard: don't transfer more than half your balance
        const balance = await ctx.conway.getCreditsBalance();
        const amount = args.amount_cents as number;
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance ($${(balance / 100).toFixed(2)}). Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          args.to_address as string,
          amount,
          args.reason as string | undefined,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Transfer to ${args.to_address}: ${args.reason || ""}`,
          timestamp: new Date().toISOString(),
        });

        return `Credit transfer submitted: $${(amount / 100).toFixed(2)} to ${transfer.toAddress} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },

    // ── Skills Tools ──
    {
      name: "install_skill",
      description: "Install a skill from a git repo, URL, marketplace, or create one.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source type: git, url, marketplace, or self",
          },
          name: { type: "string", description: "Skill name" },
          url: { type: "string", description: "Git repo URL or SKILL.md URL (for git/url)" },
          skill_id: { type: "string", description: "Marketplace skill ID (for marketplace source)" },
          description: { type: "string", description: "Skill description (for self)" },
          instructions: { type: "string", description: "Skill instructions (for self)" },
        },
        required: ["source", "name"],
      },
      execute: async (args, ctx) => {
        const source = args.source as string;
        const name = args.name as string;
        const skillsDir = ctx.config.skillsDir || "~/.automaton/skills";

        if (source === "marketplace") {
          const { installFromMarketplace } = await import("../skills/marketplace.js");
          const skillId = args.skill_id as string;
          if (!skillId) return "skill_id is required for marketplace source";
          const skill = await installFromMarketplace(skillId, ctx.db, ctx.conway, skillsDir);
          return skill ? `Skill installed from marketplace: ${skill.name}` : "Failed to install skill from marketplace";
        }

        if (source === "git" || source === "url") {
          const { installSkillFromGit, installSkillFromUrl } = await import("../skills/registry.js");
          const url = args.url as string;
          if (!url) return "URL is required for git/url source";

          const skill = source === "git"
            ? await installSkillFromGit(url, name, skillsDir, ctx.db, ctx.conway)
            : await installSkillFromUrl(url, name, skillsDir, ctx.db, ctx.conway);

          return skill ? `Skill installed: ${skill.name}` : "Failed to install skill";
        }

        if (source === "self") {
          const { createSkill } = await import("../skills/registry.js");
          const skill = await createSkill(
            name,
            (args.description as string) || "",
            (args.instructions as string) || "",
            skillsDir,
            ctx.db,
            ctx.conway,
          );
          return `Self-authored skill created: ${skill.name}`;
        }

        return `Unknown source type: ${source}`;
      },
    },
    {
      name: "list_skills",
      description: "List all installed skills.",
      category: "skills",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const skills = ctx.db.getSkills();
        if (skills.length === 0) return "No skills installed.";
        return skills
          .map(
            (s) =>
              `${s.name} [${s.enabled ? "active" : "disabled"}] (${s.source}): ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "create_skill",
      description: "Create a new skill by writing a SKILL.md file.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          description: { type: "string", description: "Skill description" },
          instructions: { type: "string", description: "Markdown instructions for the skill" },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args, ctx) => {
        const { createSkill } = await import("../skills/registry.js");
        const skill = await createSkill(
          args.name as string,
          args.description as string,
          args.instructions as string,
          ctx.config.skillsDir || "~/.automaton/skills",
          ctx.db,
          ctx.conway,
        );
        return `Skill created: ${skill.name} at ${skill.path}`;
      },
    },
    {
      name: "remove_skill",
      description: "Remove (disable) an installed skill.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to remove" },
          delete_files: { type: "boolean", description: "Also delete skill files (default: false)" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeSkill } = await import("../skills/registry.js");
        await removeSkill(
          args.name as string,
          ctx.db,
          ctx.conway,
          ctx.config.skillsDir || "~/.automaton/skills",
          (args.delete_files as boolean) || false,
        );
        return `Skill removed: ${args.name}`;
      },
    },

    // ── Marketplace Tools ──
    {
      name: "publish_skill",
      description: "Publish a local skill to the marketplace for other automatons to discover and install.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to publish" },
          version: { type: "string", description: "Version string (semver, e.g. 1.0.0)" },
          description: { type: "string", description: "Skill description for marketplace listing" },
          tags: { type: "string", description: "Comma-separated tags" },
          changelog: { type: "string", description: "What changed in this version" },
          dependencies: { type: "string", description: "JSON array of dependencies [{type,name,version?,optional?}]" },
        },
        required: ["name", "version"],
      },
      execute: async (args, ctx) => {
        const { publishSkill } = await import("../skills/marketplace.js");
        const skillName = args.name as string;
        const skill = ctx.db.getSkillByName(skillName);
        if (!skill) return `Skill not found: ${skillName}`;

        const tags = args.tags ? (args.tags as string).split(",").map((t: string) => t.trim()) : [];
        const deps = args.dependencies ? JSON.parse(args.dependencies as string) : [];

        const published = await publishSkill(
          skill,
          {
            name: skillName,
            description: (args.description as string) || skill.description,
            version: args.version as string,
            tags,
            dependencies: deps,
            changelog: args.changelog as string,
          },
          ctx.identity,
          ctx.db,
          ctx.conway,
        );
        return `Skill published to marketplace: ${published.name} v${published.version} (id: ${published.id})`;
      },
    },
    {
      name: "browse_skills",
      description: "Search and list available skills from the marketplace.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          tags: { type: "string", description: "Comma-separated tags to filter by" },
          author: { type: "string", description: "Filter by author name or address" },
          sort: { type: "string", description: "Sort by: rating, downloads, or recent (default: recent)" },
          limit: { type: "number", description: "Max results (default: 20)" },
        },
      },
      execute: async (args, ctx) => {
        const { browseSkills } = await import("../skills/marketplace.js");
        const tags = args.tags ? (args.tags as string).split(",").map((t: string) => t.trim()) : undefined;
        const skills = await browseSkills(
          {
            query: args.query as string,
            tags,
            author: args.author as string,
            sortBy: (args.sort as any) || "recent",
            limit: (args.limit as number) || 20,
          },
          ctx.db,
          ctx.conway,
        );
        if (skills.length === 0) return "No skills found in marketplace.";
        return skills
          .map(
            (s) =>
              `${s.id} | ${s.name} v${s.version} by ${s.author} | ★${s.rating.toFixed(1)} (${s.ratingCount}) | ${s.downloads} downloads | ${s.tags.join(", ") || "no tags"}\n  ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "rate_skill",
      description: "Rate an installed skill from the marketplace (1-5 stars).",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          skill_id: { type: "string", description: "Marketplace skill ID" },
          score: { type: "number", description: "Rating score (1-5)" },
          comment: { type: "string", description: "Review comment" },
        },
        required: ["skill_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        const { rateSkill } = await import("../skills/marketplace.js");
        const rating = await rateSkill(
          args.skill_id as string,
          args.score as number,
          args.comment as string,
          ctx.identity.address,
          ctx.db,
        );
        return `Rated skill ${rating.skillId}: ${rating.score}/5 stars — "${rating.comment}"`;
      },
    },
    {
      name: "check_skill_updates",
      description: "Check for newer versions of installed skills in the marketplace.",
      category: "skills",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { checkSkillUpdates } = await import("../skills/marketplace.js");
        const updates = await checkSkillUpdates(ctx.db);
        if (updates.length === 0) return "No marketplace skills with version tracking found.";
        return updates
          .map(
            (u) =>
              `${u.skill.name}: v${u.currentVersion} → v${u.latestVersion} ${u.hasUpdate ? "⬆ UPDATE AVAILABLE" : "✓ up to date"}`,
          )
          .join("\n");
      },
    },

    // ── Git Tools ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const status = await gitStatus(ctx.conway, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitDiff(ctx.conway, repoPath, (args.staged as boolean) || false);
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          message: { type: "string", description: "Commit message" },
          add_all: { type: "boolean", description: "Stage all changes first (default: true)" },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitCommit(ctx.conway, repoPath, args.message as string, args.add_all !== false);
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          limit: { type: "number", description: "Number of commits (default: 10)" },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const entries = await gitLog(ctx.conway, repoPath, (args.limit as number) || 10);
        if (entries.length === 0) return "No commits yet.";
        return entries.map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`).join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: { type: "string", description: "Remote name (default: origin)" },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.conway,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: { type: "string", description: "list, create, checkout, or delete" },
          branch_name: { type: "string", description: "Branch name (for create/checkout/delete)" },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.conway,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: { type: "number", description: "Shallow clone depth (optional)" },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.conway,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },

    // ── Registry Tools ──
    {
      name: "register_erc8004",
      description: "Register on-chain as a Trustless Agent via ERC-8004.",
      category: "registry",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          agent_uri: { type: "string", description: "URI pointing to your agent card JSON" },
          network: { type: "string", description: "mainnet or testnet (default: mainnet)" },
        },
        required: ["agent_uri"],
      },
      execute: async (args, ctx) => {
        const { registerAgent } = await import("../registry/erc8004.js");
        const entry = await registerAgent(
          ctx.identity.account,
          args.agent_uri as string,
          ((args.network as string) || "mainnet") as any,
          ctx.db,
        );
        return `Registered on-chain! Agent ID: ${entry.agentId}, TX: ${entry.txHash}`;
      },
    },
    {
      name: "update_agent_card",
      description: "Generate and save an updated agent card.",
      category: "registry",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateAgentCard, saveAgentCard } = await import("../registry/agent-card.js");
        const card = generateAgentCard(ctx.identity, ctx.config, ctx.db);
        await saveAgentCard(card, ctx.conway);
        return `Agent card updated: ${JSON.stringify(card, null, 2)}`;
      },
    },
    {
      name: "discover_agents",
      description: "Discover other agents via ERC-8004 registry.",
      category: "registry",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword (optional)" },
          limit: { type: "number", description: "Max results (default: 10)" },
          network: { type: "string", description: "mainnet or testnet" },
        },
      },
      execute: async (args, ctx) => {
        const { discoverAgents, searchAgents } = await import("../registry/discovery.js");
        const network = ((args.network as string) || "mainnet") as any;
        const keyword = args.keyword as string | undefined;
        const limit = (args.limit as number) || 10;

        const agents = keyword
          ? await searchAgents(keyword, limit, network)
          : await discoverAgents(limit, network);

        if (agents.length === 0) return "No agents found.";
        return agents
          .map(
            (a) => `#${a.agentId} ${a.name || "unnamed"} (${a.owner.slice(0, 10)}...): ${a.description || a.agentURI}`,
          )
          .join("\n");
      },
    },
    {
      name: "give_feedback",
      description: "Leave on-chain reputation feedback for another agent.",
      category: "registry",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Target agent's ERC-8004 ID" },
          score: { type: "number", description: "Score 1-5" },
          comment: { type: "string", description: "Feedback comment" },
        },
        required: ["agent_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        const { leaveFeedback } = await import("../registry/erc8004.js");
        const hash = await leaveFeedback(
          ctx.identity.account,
          args.agent_id as string,
          args.score as number,
          args.comment as string,
          "mainnet",
          ctx.db,
        );
        return `Feedback submitted. TX: ${hash}`;
      },
    },
    {
      name: "check_reputation",
      description: "Check reputation feedback for an agent.",
      category: "registry",
      parameters: {
        type: "object",
        properties: {
          agent_address: { type: "string", description: "Agent address (default: self)" },
        },
      },
      execute: async (args, ctx) => {
        const address = (args.agent_address as string) || ctx.identity.address;
        const entries = ctx.db.getReputation(address);
        if (entries.length === 0) return "No reputation feedback found.";
        return entries
          .map(
            (e) => `${e.fromAgent.slice(0, 10)}... -> score:${e.score} "${e.comment}"`,
          )
          .join("\n");
      },
    },

    // ── Replication Tools ──
    {
      name: "spawn_child",
      description: "Spawn a child automaton using smart replication strategy. Checks profitability, calculates budget, determines specialization, and applies mutations. Pass force=true to skip strategy checks.",
      category: "replication",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the child automaton (auto-generated if omitted)" },
          specialization: { type: "string", description: "Override specialization (strategy engine picks one if omitted)" },
          message: { type: "string", description: "Message to the child" },
          force: { type: "boolean", description: "Skip strategy checks and spawn anyway" },
        },
      },
      execute: async (args, ctx) => {
        const { evaluateReplicationStrategy, buildGenesisFromStrategy } = await import("../replication/strategy.js");
        const { generateGenesisConfig } = await import("../replication/genesis.js");
        const { spawnChild } = await import("../replication/spawn.js");

        const balance = await ctx.conway.getCreditsBalance();

        // Run strategy engine unless forced
        if (!args.force) {
          const decision = evaluateReplicationStrategy(ctx.db, ctx.config, ctx.identity, balance);
          if (!decision.allowed) {
            return `Replication blocked by strategy engine: ${decision.reason}`;
          }

          // Use strategy-generated genesis if no manual override
          const genesis = args.specialization
            ? generateGenesisConfig(ctx.identity, ctx.config, {
                name: (args.name as string) || decision.suggestedName || `${ctx.config.name}-child`,
                specialization: args.specialization as string,
                message: args.message as string | undefined,
              })
            : buildGenesisFromStrategy(ctx.identity, ctx.config, decision, ctx.db);

          if (args.name) genesis.name = args.name as string;

          const child = await spawnChild(ctx.conway, ctx.identity, ctx.db, genesis);
          return `Child spawned via strategy engine: ${child.name} in sandbox ${child.sandboxId} (specialization: ${decision.suggestedSpecialization}, budget: $${((decision.suggestedFundingCents || 0) / 100).toFixed(2)}, mutations: ${JSON.stringify(decision.mutations || {})})`;
        }

        // Force mode: original behavior
        const genesis = generateGenesisConfig(ctx.identity, ctx.config, {
          name: (args.name as string) || `${ctx.config.name}-child`,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const child = await spawnChild(ctx.conway, ctx.identity, ctx.db, genesis);
        return `Child spawned (forced): ${child.name} in sandbox ${child.sandboxId} (status: ${child.status})`;
      },
    },
    {
      name: "list_children",
      description: "List all spawned child automatons.",
      category: "replication",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children spawned.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] sandbox:${c.sandboxId} funded:$${(c.fundedAmountCents / 100).toFixed(2)}`,
          )
          .join("\n");
      },
    },
    {
      name: "fund_child",
      description: "Transfer credits to a child automaton.",
      category: "replication",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          amount_cents: { type: "number", description: "Amount in cents to transfer" },
        },
        required: ["child_id", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const balance = await ctx.conway.getCreditsBalance();
        const amount = args.amount_cents as number;
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance. Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          child.address,
          amount,
          `fund child ${child.id}`,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Fund child ${child.name} (${child.id})`,
          timestamp: new Date().toISOString(),
        });

        return `Funded child ${child.name} with $${(amount / 100).toFixed(2)} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },
    {
      name: "check_child_status",
      description: "Check the current status of a child automaton.",
      category: "replication",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const { checkChildStatus } = await import("../replication/spawn.js");
        return await checkChildStatus(ctx.conway, ctx.db, args.child_id as string);
      },
    },

    {
      name: "replication_report",
      description: "Show lineage tree, child performance, ROI per child, and recommendations.",
      category: "replication",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateEvaluationReport, formatEvaluationReport } = await import("../replication/evaluation.js");
        const { getLineageSummary } = await import("../replication/lineage.js");

        const lineage = getLineageSummary(ctx.db, ctx.config);
        const report = generateEvaluationReport(ctx.db);
        const formatted = formatEvaluationReport(report);

        return `── Lineage ──\n${lineage}\n\n${formatted}`;
      },
    },

    // ── Social / Messaging Tools ──
    {
      name: "send_message",
      description:
        "Send a message to another automaton or address via the social relay.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          to_address: {
            type: "string",
            description: "Recipient wallet address (0x...)",
          },
          content: {
            type: "string",
            description: "Message content to send",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
        },
        required: ["to_address", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        const result = await ctx.social.send(
          args.to_address as string,
          args.content as string,
          args.reply_to as string | undefined,
        );
        return `Message sent (id: ${result.id})`;
      },
    },

    // ── Model Discovery ──
    {
      name: "list_models",
      description:
        "List all available inference models from the Conway API with their provider and pricing. Use this to discover what models you can use and pick the best one for your needs.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        const models = await ctx.conway.listModels();
        const lines = models.map(
          (m) =>
            `${m.id} (${m.provider}) — $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per 1M tokens (in/out)`,
        );
        return `Available models:\n${lines.join("\n")}`;
      },
    },

    // ── Domain Tools ──
    {
      name: "search_domains",
      description:
        "Search for available domain names and get pricing.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Domain name or keyword to search (e.g., 'mysite' or 'mysite.com')",
          },
          tlds: {
            type: "string",
            description: "Comma-separated TLDs to check (e.g., 'com,io,ai'). Default: com,io,ai,xyz,net,org,dev",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const results = await ctx.conway.searchDomains(
          args.query as string,
          args.tlds as string | undefined,
        );
        if (results.length === 0) return "No results found.";
        return results
          .map(
            (d) =>
              `${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${d.registrationPrice != null ? ` ($${(d.registrationPrice / 100).toFixed(2)}/yr)` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "register_domain",
      description:
        "Register a domain name. Costs USDC via x402 payment. Check availability first with search_domains.",
      category: "conway",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Full domain to register (e.g., 'mysite.com')",
          },
          years: {
            type: "number",
            description: "Registration period in years (default: 1)",
          },
        },
        required: ["domain"],
      },
      execute: async (args, ctx) => {
        const reg = await ctx.conway.registerDomain(
          args.domain as string,
          (args.years as number) || 1,
        );
        return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
      },
    },
    {
      name: "manage_dns",
      description:
        "Manage DNS records for a domain you own. Actions: list, add, delete.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list, add, or delete",
          },
          domain: {
            type: "string",
            description: "Domain name (e.g., 'mysite.com')",
          },
          type: {
            type: "string",
            description: "Record type for add: A, AAAA, CNAME, MX, TXT, etc.",
          },
          host: {
            type: "string",
            description: "Record host for add (e.g., '@' for root, 'www')",
          },
          value: {
            type: "string",
            description: "Record value for add (e.g., IP address, target domain)",
          },
          ttl: {
            type: "number",
            description: "TTL in seconds for add (default: 3600)",
          },
          record_id: {
            type: "string",
            description: "Record ID for delete",
          },
        },
        required: ["action", "domain"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const domain = args.domain as string;

        if (action === "list") {
          const records = await ctx.conway.listDnsRecords(domain);
          if (records.length === 0) return `No DNS records found for ${domain}.`;
          return records
            .map(
              (r) => `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "default"})`,
            )
            .join("\n");
        }

        if (action === "add") {
          const type = args.type as string;
          const host = args.host as string;
          const value = args.value as string;
          if (!type || !host || !value) {
            return "Required for add: type, host, value";
          }
          const record = await ctx.conway.addDnsRecord(
            domain,
            type,
            host,
            value,
            args.ttl as number | undefined,
          );
          return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
        }

        if (action === "delete") {
          const recordId = args.record_id as string;
          if (!recordId) return "Required for delete: record_id";
          await ctx.conway.deleteDnsRecord(domain, recordId);
          return `DNS record ${recordId} deleted from ${domain}`;
        }

        return `Unknown action: ${action}. Use list, add, or delete.`;
      },
    },

    // ── Revenue Dashboard Tool ──
    {
      name: "revenue_dashboard",
      description:
        "Show a formatted revenue dashboard with P&L (daily, weekly, all-time), top revenue sources, cost breakdown, trend analysis, and runway projection.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { buildRevenueDashboard, formatDashboard } = await import("../survival/revenue.js");
        const credits = await ctx.conway.getCreditsBalance();
        const dashboard = buildRevenueDashboard(ctx.db, credits);
        return formatDashboard(dashboard);
      },
    },

    // ── x402 Payment Tool ──
    {
      name: "x402_fetch",
      description:
        "Fetch a URL with automatic x402 USDC payment. If the server responds with HTTP 402, signs a USDC payment and retries. Use this to access paid APIs and services.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { x402Fetch } = await import("../conway/x402.js");
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : undefined;

        const result = await x402Fetch(
          url,
          ctx.identity.account,
          method,
          body,
          extraHeaders,
        );

        if (!result.success) {
          return `x402 fetch failed: ${result.error || "Unknown error"}`;
        }

        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);

        // Truncate very large responses
        if (responseStr.length > 10000) {
          return `x402 fetch succeeded (truncated):\n${responseStr.slice(0, 10000)}...`;
        }
        return `x402 fetch succeeded:\n${responseStr}`;
      },
    },
  ];
}

/**
 * Create all builtin tools including web tools.
 */
export function createModelStatsTools(): AutomatonTool[] {
  return [
    {
      name: "model_stats",
      description:
        "Show model usage breakdown, cost per model, and savings from intelligent routing.",
      parameters: {
        type: "object",
        properties: {},
      },
      category: "survival" as ToolCategory,
      execute: async (
        _args: Record<string, unknown>,
        context: ToolContext,
      ): Promise<string> => {
        const { getModelStats } = await import("./model-router.js");
        const stats = getModelStats(context.db);
        if (stats.totalCalls === 0) {
          return "No model routing stats yet. Stats are recorded after each inference call.";
        }
        const lines: string[] = [
          `=== Model Routing Stats ===`,
          `Total calls: ${stats.totalCalls}`,
          `Routed cheap: ${stats.routedCheap} (${((stats.routedCheap / stats.totalCalls) * 100).toFixed(1)}%)`,
          `Routed expensive: ${stats.routedExpensive} (${((stats.routedExpensive / stats.totalCalls) * 100).toFixed(1)}%)`,
          `Estimated savings: $${(stats.estimatedSavingsCents / 100).toFixed(4)}`,
          ``,
          `--- Per Model ---`,
        ];
        for (const [model, calls] of Object.entries(stats.callsByModel)) {
          const cost = stats.costByModel[model] || 0;
          lines.push(`${model}: ${calls} calls, $${(cost / 100).toFixed(4)} cost`);
        }
        return lines.join("\n");
      },
    },
  ];
}

export function createCollaborationTools(): AutomatonTool[] {
  return [
    {
      name: "request_task",
      description:
        "Send a structured task request to another agent. Creates an escrow hold for the payment amount.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Worker agent wallet address" },
          description: { type: "string", description: "Task description" },
          requirements: { type: "string", description: "Comma-separated requirements" },
          payment_cents: { type: "number", description: "Payment offer in cents" },
          deadline: { type: "string", description: "ISO deadline (optional)" },
        },
        required: ["to_address", "description", "payment_cents"],
      },
      execute: async (args, ctx) => {
        const { CollaborationManager } = await import("../social/collaboration.js");
        const mgr = getOrCreateCollabManager(ctx);
        const reqs = args.requirements ? (args.requirements as string).split(",").map((r: string) => r.trim()) : [];
        const task = await mgr.requestTask(
          args.to_address as string,
          args.description as string,
          reqs,
          args.payment_cents as number,
          args.deadline as string | undefined,
        );
        return `Task requested: ${task.id} (status: ${task.status}, escrow: $${(task.paymentOfferCents / 100).toFixed(2)})`;
      },
    },
    {
      name: "respond_to_task",
      description:
        "Accept, reject, or negotiate an incoming task request.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          action: { type: "string", description: "accept, reject, or negotiate" },
          counter_offer_cents: { type: "number", description: "Counter-offer amount (for negotiate)" },
          message: { type: "string", description: "Response message" },
        },
        required: ["task_id", "action"],
      },
      execute: async (args, ctx) => {
        const mgr = getOrCreateCollabManager(ctx);
        const task = await mgr.respondToTask(
          args.task_id as string,
          args.action as "accept" | "reject" | "negotiate",
          args.counter_offer_cents as number | undefined,
          args.message as string | undefined,
        );
        return `Task ${task.id}: ${task.status}${task.counterOfferCents ? ` (counter: $${(task.counterOfferCents / 100).toFixed(2)})` : ""}`;
      },
    },
    {
      name: "deliver_task",
      description:
        "Submit deliverables for a task you're working on.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          deliverables: { type: "string", description: "Description of deliverables" },
        },
        required: ["task_id", "deliverables"],
      },
      execute: async (args, ctx) => {
        const mgr = getOrCreateCollabManager(ctx);
        const task = await mgr.deliverTask(
          args.task_id as string,
          args.deliverables as string,
        );
        return `Task ${task.id} delivered. Awaiting verification.`;
      },
    },
    {
      name: "verify_delivery",
      description:
        "Verify and approve or reject delivered work for a task you requested.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          approved: { type: "boolean", description: "true to approve, false to dispute" },
          notes: { type: "string", description: "Verification notes" },
        },
        required: ["task_id", "approved"],
      },
      execute: async (args, ctx) => {
        const mgr = getOrCreateCollabManager(ctx);
        const task = await mgr.verifyDelivery(
          args.task_id as string,
          args.approved as boolean,
          args.notes as string | undefined,
        );
        const escrow = mgr.getEscrow(task.id);
        if (task.status === "verified") {
          mgr.releasePayment(task.id);
          return `Task ${task.id} verified and paid. Escrow released.`;
        }
        return `Task ${task.id} disputed. Notes: ${args.notes || "none"}`;
      },
    },
    {
      name: "list_tasks",
      description:
        "List collaboration tasks (incoming/outgoing) with status.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "requester or worker (optional)" },
          status: { type: "string", description: "Filter by status (optional)" },
        },
      },
      execute: async (args, ctx) => {
        const mgr = getOrCreateCollabManager(ctx);
        const tasks = mgr.listTasks({
          role: args.role as "requester" | "worker" | undefined,
          status: args.status as any,
        });
        if (tasks.length === 0) return "No collaboration tasks found.";
        const escrowTotal = mgr.getTotalEscrowHeld();
        const lines = tasks.map(
          (t: any) => `${t.id} [${t.status}] ${t.description.slice(0, 60)} | $${(t.paymentOfferCents / 100).toFixed(2)} | ${t.requesterAddress.slice(0, 10)}→${t.workerAddress.slice(0, 10)}`,
        );
        lines.push(`\nTotal escrow held: $${(escrowTotal / 100).toFixed(2)}`);
        return lines.join("\n");
      },
    },
  ];
}

// Singleton collab managers per context
const collabManagers = new WeakMap<ToolContext, any>();

function getOrCreateCollabManager(ctx: ToolContext) {
  let mgr = collabManagers.get(ctx);
  if (!mgr) {
    const { CollaborationManager } = require("../social/collaboration.js");
    mgr = new CollaborationManager(ctx.identity.address, ctx.social);
    collabManagers.set(ctx, mgr);
  }
  return mgr;
}

export function createPluginTools(): AutomatonTool[] {
  return [
    {
      name: "install_plugin",
      description: "Install a plugin from a local path, npm package, or git URL.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source type: local, npm, or git" },
          path_or_package: { type: "string", description: "Local path, npm package name, or git URL" },
          plugins_dir: { type: "string", description: "Plugins directory (default: ~/.automaton/plugins)" },
        },
        required: ["source", "path_or_package"],
      },
      execute: async (args, ctx) => {
        const { installFromLocal, installFromNpm, installFromGit } = await import("../plugins/registry.js");
        const pluginsDir = (args.plugins_dir as string) || "~/.automaton/plugins";
        const source = args.source as string;
        const target = args.path_or_package as string;

        let result;
        if (source === "local") {
          result = await installFromLocal(target, pluginsDir);
        } else if (source === "npm") {
          result = await installFromNpm(target, pluginsDir, ctx.conway);
        } else if (source === "git") {
          result = await installFromGit(target, pluginsDir, ctx.conway);
        } else {
          return `Unknown source type: ${source}. Use local, npm, or git.`;
        }

        if (!result.success) return `Plugin install failed: ${result.error}`;
        return `Plugin installed: ${result.name} v${result.version}`;
      },
    },
    {
      name: "list_plugins",
      description: "List all installed plugins with their status.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          plugins_dir: { type: "string", description: "Plugins directory (default: ~/.automaton/plugins)" },
        },
      },
      execute: async (args, ctx) => {
        const { PluginLoader } = await import("../plugins/loader.js");
        const pluginsDir = (args.plugins_dir as string) || "~/.automaton/plugins";
        const loader = new PluginLoader(pluginsDir, ctx.db);
        await loader.loadAll();
        const plugins = loader.getAllPlugins();
        if (plugins.length === 0) return "No plugins installed.";
        return plugins.map((p) =>
          `${p.manifest.name} v${p.manifest.version} [${p.enabled ? "enabled" : "disabled"}] — ${p.manifest.description} (tools: ${p.tools.length}, hooks: ${p.manifest.hooks?.length || 0})`
        ).join("\n");
      },
    },
    {
      name: "enable_plugin",
      description: "Enable a previously disabled plugin.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name to enable" },
          plugins_dir: { type: "string", description: "Plugins directory (default: ~/.automaton/plugins)" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { PluginLoader } = await import("../plugins/loader.js");
        const pluginsDir = (args.plugins_dir as string) || "~/.automaton/plugins";
        const loader = new PluginLoader(pluginsDir, ctx.db);
        await loader.loadAll();
        const ok = loader.enablePlugin(args.name as string);
        return ok ? `Plugin ${args.name} enabled.` : `Plugin ${args.name} not found.`;
      },
    },
    {
      name: "disable_plugin",
      description: "Disable a plugin without uninstalling it.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name to disable" },
          plugins_dir: { type: "string", description: "Plugins directory (default: ~/.automaton/plugins)" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { PluginLoader } = await import("../plugins/loader.js");
        const pluginsDir = (args.plugins_dir as string) || "~/.automaton/plugins";
        const loader = new PluginLoader(pluginsDir, ctx.db);
        await loader.loadAll();
        const ok = loader.disablePlugin(args.name as string);
        return ok ? `Plugin ${args.name} disabled.` : `Plugin ${args.name} not found.`;
      },
    },
    {
      name: "plugin_info",
      description: "Show detailed info about a specific plugin.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name" },
          plugins_dir: { type: "string", description: "Plugins directory (default: ~/.automaton/plugins)" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { PluginLoader } = await import("../plugins/loader.js");
        const { hookRegistry } = await import("../plugins/hooks.js");
        const pluginsDir = (args.plugins_dir as string) || "~/.automaton/plugins";
        const loader = new PluginLoader(pluginsDir, ctx.db);
        await loader.loadAll();
        const plugin = loader.getPlugin(args.name as string);
        if (!plugin) return `Plugin ${args.name} not found.`;

        const hooks = hookRegistry.getRegisteredHooks(plugin.manifest.name);
        return `=== Plugin: ${plugin.manifest.name} ===
Version: ${plugin.manifest.version}
Description: ${plugin.manifest.description}
Status: ${plugin.enabled ? "enabled" : "disabled"}
Directory: ${plugin.dir}
Loaded at: ${plugin.loadedAt}
Tools: ${plugin.tools.map((t) => t.name).join(", ") || "none"}
Hooks: ${hooks.map((h) => h.hookName).join(", ") || "none"}
Dependencies: ${JSON.stringify(plugin.manifest.dependencies || {})}`;
      },
    },
  ];
}

export function createQuotaTools(): AutomatonTool[] {
  return [
    {
      name: "quota_status",
      description:
        "Show current quota usage, limits, and reset times for all tracked quotas (inference calls, tool calls, API requests, x402 spend).",
      category: "survival" as ToolCategory,
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getQuotaManager } = await import("../utils/quota-manager.js");
        const qm = getQuotaManager();
        return qm.formatStatus();
      },
    },
  ];
}

export function createAllTools(sandboxId: string): AutomatonTool[] {
  // Lazy import to avoid circular deps at module level
  const { createWebTools } = require("./web-tools.js");
  const { createServerTools } = require("./server-tools.js");
  const { createSchedulerTools } = require("./scheduler-tools.js");
  const { createMigrationTools } = require("../migration/tools.js");
  return [...createBuiltinTools(sandboxId), ...createWebTools(), ...createServerTools(), ...createSchedulerTools(), ...createModelStatsTools(), ...createCollaborationTools(), ...createPluginTools(), ...createQuotaTools(), ...createMigrationTools()];
}

/**
 * Convert AutomatonTool list to OpenAI-compatible tool definitions.
 */
export function toolsToInferenceFormat(
  tools: AutomatonTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: AutomatonTool[],
  context: ToolContext,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  try {
    const result = await tool.execute(args, context);
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: err.message || String(err),
    };
  }
}
