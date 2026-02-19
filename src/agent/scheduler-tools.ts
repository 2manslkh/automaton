/**
 * Scheduler Tools
 *
 * Provides cron/scheduler capabilities beyond the heartbeat system.
 * Tasks are persisted in the database and executed by the heartbeat daemon.
 */

import cronParser from "cron-parser";
import type { AutomatonTool, ScheduledTask, TaskRun } from "../types.js";

/**
 * Compute the next run time for a task based on its schedule or delay.
 */
export function computeNextRun(task: { schedule?: string; delayMs?: number; lastRun?: string }): string | null {
  if (task.schedule) {
    try {
      const interval = cronParser.parseExpression(task.schedule, {
        currentDate: task.lastRun ? new Date(task.lastRun) : new Date(),
      });
      return interval.next().toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (task.delayMs) {
    const base = task.lastRun ? new Date(task.lastRun) : new Date();
    return new Date(base.getTime() + task.delayMs).toISOString();
  }
  return null;
}

/**
 * Execute a scheduled task's payload.
 */
export async function executeScheduledTask(
  task: ScheduledTask,
  ctx: { conway: any; db: any },
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    switch (task.type) {
      case "shell": {
        const command = task.payload.command as string;
        if (!command) return { success: false, error: "No command in payload" };
        const result = await ctx.conway.exec(command, (task.payload.timeout as number) || 30000);
        return {
          success: result.exitCode === 0,
          result: `exit:${result.exitCode} stdout:${(result.stdout || "").slice(0, 2000)}`,
          error: result.exitCode !== 0 ? result.stderr : undefined,
        };
      }
      case "inference": {
        const prompt = task.payload.prompt as string;
        if (!prompt) return { success: false, error: "No prompt in payload" };
        // Store the prompt request in KV for the agent to pick up on next wake
        ctx.db.setKV(`scheduler_inference_${task.id}`, JSON.stringify({
          prompt,
          model: task.payload.model,
          requestedAt: new Date().toISOString(),
        }));
        return { success: true, result: `Inference request queued for agent: ${prompt.slice(0, 100)}` };
      }
      case "tool_call": {
        const toolName = task.payload.tool as string;
        const toolArgs = (task.payload.args as Record<string, unknown>) || {};
        if (!toolName) return { success: false, error: "No tool name in payload" };
        // Store tool call request for the agent to execute on next wake
        ctx.db.setKV(`scheduler_toolcall_${task.id}`, JSON.stringify({
          tool: toolName,
          args: toolArgs,
          requestedAt: new Date().toISOString(),
        }));
        return { success: true, result: `Tool call queued: ${toolName}` };
      }
      default:
        return { success: false, error: `Unknown task type: ${task.type}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Process all due scheduled tasks. Called from heartbeat daemon tick.
 */
export async function processDueScheduledTasks(ctx: { conway: any; db: any }): Promise<number> {
  const dueTasks = ctx.db.getDueScheduledTasks() as ScheduledTask[];
  let executed = 0;

  for (const task of dueTasks) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const result = await executeScheduledTask(task, ctx);

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    // Record the run
    const { ulid } = await import("ulid");
    const run: TaskRun = {
      id: ulid(),
      taskId: task.id,
      startedAt,
      finishedAt,
      success: result.success,
      result: result.result,
      error: result.error,
      durationMs,
    };
    ctx.db.insertTaskRun(run);

    // Update the task
    if (task.oneShot) {
      ctx.db.updateScheduledTaskStatus(task.id, "completed");
      ctx.db.updateScheduledTaskLastRun(task.id, finishedAt, null);
    } else {
      const nextRun = computeNextRun({ ...task, lastRun: finishedAt });
      ctx.db.updateScheduledTaskLastRun(task.id, finishedAt, nextRun);
    }

    executed++;
  }

  return executed;
}

/**
 * Create scheduler tools for the agent.
 */
export function createSchedulerTools(): AutomatonTool[] {
  return [
    {
      name: "schedule_task",
      description:
        "Schedule a one-shot or recurring task. Tasks can be shell commands, inference prompts, or tool calls. " +
        "Use 'schedule' for cron expressions (e.g., '*/5 * * * *') or 'delay_ms' for one-shot delays.",
      category: "scheduler",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable task name" },
          type: { type: "string", description: "Task type: shell, inference, or tool_call" },
          schedule: { type: "string", description: "Cron expression for recurring tasks (e.g., '0 */6 * * *')" },
          delay_ms: { type: "number", description: "Delay in ms for one-shot tasks (e.g., 60000 for 1 min)" },
          payload: { type: "string", description: "JSON payload. For shell: {\"command\":\"...\"}, inference: {\"prompt\":\"...\"}, tool_call: {\"tool\":\"...\",\"args\":{...}}" },
        },
        required: ["name", "type", "payload"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const id = ulid();
        const name = args.name as string;
        const type = args.type as "shell" | "inference" | "tool_call";
        const schedule = args.schedule as string | undefined;
        const delayMs = args.delay_ms as number | undefined;

        if (!schedule && !delayMs) {
          return "Error: Either 'schedule' (cron) or 'delay_ms' must be provided.";
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(args.payload as string);
        } catch {
          return "Error: payload must be valid JSON.";
        }

        // Validate cron if provided
        if (schedule) {
          try {
            cronParser.parseExpression(schedule);
          } catch {
            return `Error: Invalid cron expression '${schedule}'.`;
          }
        }

        const oneShot = !schedule;
        const now = new Date().toISOString();
        const nextRun = computeNextRun({ schedule, delayMs });

        const task: ScheduledTask = {
          id,
          name,
          type,
          schedule,
          delayMs,
          payload,
          enabled: true,
          oneShot,
          nextRun: nextRun || undefined,
          runCount: 0,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };

        ctx.db.upsertScheduledTask(task);

        return `Task scheduled: ${name} (id: ${id}, type: ${type}, ${schedule ? `cron: ${schedule}` : `delay: ${delayMs}ms`}, next run: ${nextRun || "unknown"})`;
      },
    },
    {
      name: "list_scheduled",
      description: "List all scheduled tasks with next run time, status, and run history summary.",
      category: "scheduler",
      parameters: {
        type: "object",
        properties: {
          active_only: { type: "boolean", description: "Only show active tasks (default: false)" },
        },
      },
      execute: async (args, ctx) => {
        const activeOnly = args.active_only as boolean | undefined;
        const tasks = ctx.db.getScheduledTasks(activeOnly) as ScheduledTask[];

        if (tasks.length === 0) return "No scheduled tasks.";

        const lines = tasks.map((t) => {
          const sched = t.schedule ? `cron: ${t.schedule}` : `delay: ${t.delayMs}ms`;
          return `[${t.id}] ${t.name} (${t.type}) — ${sched} | status: ${t.status} | runs: ${t.runCount} | next: ${t.nextRun || "none"} | last: ${t.lastRun || "never"}`;
        });

        return lines.join("\n");
      },
    },
    {
      name: "cancel_task",
      description: "Cancel a scheduled task by ID.",
      category: "scheduler",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to cancel" },
          delete: { type: "boolean", description: "Permanently delete the task and its history (default: false)" },
        },
        required: ["task_id"],
      },
      execute: async (args, ctx) => {
        const taskId = args.task_id as string;
        const task = ctx.db.getScheduledTaskById(taskId) as ScheduledTask | undefined;

        if (!task) return `Task not found: ${taskId}`;

        if (args.delete) {
          ctx.db.deleteScheduledTask(taskId);
          return `Task '${task.name}' (${taskId}) permanently deleted.`;
        }

        ctx.db.updateScheduledTaskStatus(taskId, "cancelled");
        return `Task '${task.name}' (${taskId}) cancelled.`;
      },
    },
    {
      name: "task_history",
      description: "View execution history for a scheduled task.",
      category: "scheduler",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          limit: { type: "number", description: "Number of recent runs to show (default: 10)" },
        },
        required: ["task_id"],
      },
      execute: async (args, ctx) => {
        const taskId = args.task_id as string;
        const task = ctx.db.getScheduledTaskById(taskId) as ScheduledTask | undefined;

        if (!task) return `Task not found: ${taskId}`;

        const limit = (args.limit as number) || 10;
        const runs = ctx.db.getTaskRuns(taskId, limit) as TaskRun[];

        if (runs.length === 0) return `Task '${task.name}' has no execution history.`;

        const header = `Task: ${task.name} (${task.type}) — ${task.runCount} total runs\n`;
        const lines = runs.map((r) => {
          const status = r.success ? "✓" : "✗";
          const detail = r.error ? `error: ${r.error.slice(0, 200)}` : (r.result || "").slice(0, 200);
          return `  ${status} ${r.startedAt} (${r.durationMs}ms) — ${detail}`;
        });

        return header + lines.join("\n");
      },
    },
  ];
}
