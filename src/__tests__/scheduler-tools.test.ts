import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeNextRun, executeScheduledTask, processDueScheduledTasks, createSchedulerTools } from "../agent/scheduler-tools.js";
import type { ScheduledTask, TaskRun } from "../types.js";

// ─── Mock DB ──────────────────────────────────────────────────

function createMockDb() {
  const tasks: Map<string, ScheduledTask> = new Map();
  const runs: TaskRun[] = [];

  return {
    tasks,
    runs,
    getScheduledTasks: vi.fn((enabledOnly?: boolean) => {
      const all = [...tasks.values()];
      return enabledOnly ? all.filter((t) => t.enabled) : all;
    }),
    getScheduledTaskById: vi.fn((id: string) => tasks.get(id)),
    upsertScheduledTask: vi.fn((task: ScheduledTask) => { tasks.set(task.id, task); }),
    updateScheduledTaskStatus: vi.fn((id: string, status: string) => {
      const t = tasks.get(id);
      if (t) { t.status = status as any; t.enabled = status === "active"; }
    }),
    updateScheduledTaskLastRun: vi.fn((id: string, lastRun: string, nextRun: string | null) => {
      const t = tasks.get(id);
      if (t) { t.lastRun = lastRun; t.nextRun = nextRun || undefined; t.runCount++; }
    }),
    deleteScheduledTask: vi.fn((id: string) => { tasks.delete(id); }),
    getDueScheduledTasks: vi.fn(() => {
      const now = new Date().toISOString();
      return [...tasks.values()].filter((t) => t.enabled && t.status === "active" && t.nextRun && t.nextRun <= now);
    }),
    insertTaskRun: vi.fn((run: TaskRun) => { runs.push(run); }),
    getTaskRuns: vi.fn((taskId: string, limit: number) =>
      runs.filter((r) => r.taskId === taskId).slice(0, limit)
    ),
    getKV: vi.fn(() => undefined),
    setKV: vi.fn(),
  };
}

function createMockConway() {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "hello", stderr: "" })),
  };
}

function createMockContext(db: any) {
  return {
    identity: { address: "0x1234", sandboxId: "test-sandbox", name: "test", apiKey: "", createdAt: "", creatorAddress: "0x0000" as any, account: {} as any },
    config: {} as any,
    db,
    conway: createMockConway(),
    inference: { chat: vi.fn(), setLowComputeMode: vi.fn(), getDefaultModel: () => "gpt-4o" },
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe("computeNextRun", () => {
  it("computes next run from cron expression", () => {
    const result = computeNextRun({ schedule: "*/5 * * * *" });
    expect(result).toBeTruthy();
    const next = new Date(result!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("computes next run from delay_ms", () => {
    const result = computeNextRun({ delayMs: 60000 });
    expect(result).toBeTruthy();
    const next = new Date(result!);
    // Should be ~60 seconds from now
    expect(next.getTime() - Date.now()).toBeGreaterThan(50000);
    expect(next.getTime() - Date.now()).toBeLessThan(70000);
  });

  it("returns null when no schedule or delay", () => {
    expect(computeNextRun({})).toBeNull();
  });

  it("returns null for invalid cron", () => {
    expect(computeNextRun({ schedule: "not a cron" })).toBeNull();
  });
});

describe("executeScheduledTask", () => {
  it("executes a shell task", async () => {
    const conway = createMockConway();
    const db = createMockDb();
    const task: ScheduledTask = {
      id: "t1", name: "test-shell", type: "shell",
      payload: { command: "echo hello" },
      enabled: true, oneShot: false, runCount: 0,
      status: "active", createdAt: "", updatedAt: "",
    };

    const result = await executeScheduledTask(task, { conway, db });
    expect(result.success).toBe(true);
    expect(conway.exec).toHaveBeenCalledWith("echo hello", 30000);
  });

  it("handles shell task failure", async () => {
    const conway = { exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "fail" })) };
    const db = createMockDb();
    const task: ScheduledTask = {
      id: "t1", name: "test-fail", type: "shell",
      payload: { command: "false" },
      enabled: true, oneShot: false, runCount: 0,
      status: "active", createdAt: "", updatedAt: "",
    };

    const result = await executeScheduledTask(task, { conway, db });
    expect(result.success).toBe(false);
    expect(result.error).toBe("fail");
  });

  it("queues inference task", async () => {
    const conway = createMockConway();
    const db = createMockDb();
    const task: ScheduledTask = {
      id: "t2", name: "test-inference", type: "inference",
      payload: { prompt: "What time is it?" },
      enabled: true, oneShot: true, runCount: 0,
      status: "active", createdAt: "", updatedAt: "",
    };

    const result = await executeScheduledTask(task, { conway, db });
    expect(result.success).toBe(true);
    expect(db.setKV).toHaveBeenCalled();
  });

  it("queues tool_call task", async () => {
    const conway = createMockConway();
    const db = createMockDb();
    const task: ScheduledTask = {
      id: "t3", name: "test-tool", type: "tool_call",
      payload: { tool: "check_credits", args: {} },
      enabled: true, oneShot: true, runCount: 0,
      status: "active", createdAt: "", updatedAt: "",
    };

    const result = await executeScheduledTask(task, { conway, db });
    expect(result.success).toBe(true);
    expect(db.setKV).toHaveBeenCalled();
  });
});

describe("processDueScheduledTasks", () => {
  it("processes due tasks and records runs", async () => {
    const db = createMockDb();
    const conway = createMockConway();

    // Add a task that's due now
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const task: ScheduledTask = {
      id: "due1", name: "due-task", type: "shell",
      schedule: "*/5 * * * *",
      payload: { command: "echo done" },
      enabled: true, oneShot: false, runCount: 0,
      nextRun: pastTime,
      status: "active", createdAt: "", updatedAt: "",
    };
    db.tasks.set("due1", task);

    const count = await processDueScheduledTasks({ conway, db });
    expect(count).toBe(1);
    expect(db.insertTaskRun).toHaveBeenCalledTimes(1);
    expect(db.updateScheduledTaskLastRun).toHaveBeenCalledTimes(1);
  });

  it("marks one-shot tasks as completed", async () => {
    const db = createMockDb();
    const conway = createMockConway();

    const pastTime = new Date(Date.now() - 60000).toISOString();
    const task: ScheduledTask = {
      id: "oneshot1", name: "oneshot-task", type: "shell",
      delayMs: 1000,
      payload: { command: "echo once" },
      enabled: true, oneShot: true, runCount: 0,
      nextRun: pastTime,
      status: "active", createdAt: "", updatedAt: "",
    };
    db.tasks.set("oneshot1", task);

    await processDueScheduledTasks({ conway, db });
    expect(db.updateScheduledTaskStatus).toHaveBeenCalledWith("oneshot1", "completed");
  });

  it("skips tasks that are not due", async () => {
    const db = createMockDb();
    const conway = createMockConway();

    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const task: ScheduledTask = {
      id: "future1", name: "future-task", type: "shell",
      schedule: "0 */6 * * *",
      payload: { command: "echo later" },
      enabled: true, oneShot: false, runCount: 0,
      nextRun: futureTime,
      status: "active", createdAt: "", updatedAt: "",
    };
    db.tasks.set("future1", task);

    const count = await processDueScheduledTasks({ conway, db });
    expect(count).toBe(0);
  });
});

describe("scheduler tools", () => {
  const tools = createSchedulerTools();

  it("creates 4 tools", () => {
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "schedule_task", "list_scheduled", "cancel_task", "task_history",
    ]);
  });

  describe("schedule_task", () => {
    it("schedules a cron task", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "schedule_task")!;

      const result = await tool.execute({
        name: "my-task",
        type: "shell",
        schedule: "*/10 * * * *",
        payload: JSON.stringify({ command: "echo hi" }),
      }, ctx as any);

      expect(result).toContain("Task scheduled: my-task");
      expect(db.upsertScheduledTask).toHaveBeenCalledTimes(1);
    });

    it("schedules a one-shot delay task", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "schedule_task")!;

      const result = await tool.execute({
        name: "reminder",
        type: "inference",
        delay_ms: 60000,
        payload: JSON.stringify({ prompt: "Remind me" }),
      }, ctx as any);

      expect(result).toContain("Task scheduled: reminder");
      expect(result).toContain("delay: 60000ms");
    });

    it("rejects missing schedule and delay", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "schedule_task")!;

      const result = await tool.execute({
        name: "bad",
        type: "shell",
        payload: JSON.stringify({ command: "echo" }),
      }, ctx as any);

      expect(result).toContain("Error");
    });

    it("rejects invalid cron", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "schedule_task")!;

      const result = await tool.execute({
        name: "bad-cron",
        type: "shell",
        schedule: "not valid",
        payload: JSON.stringify({ command: "echo" }),
      }, ctx as any);

      expect(result).toContain("Invalid cron");
    });
  });

  describe("list_scheduled", () => {
    it("shows empty state", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "list_scheduled")!;

      const result = await tool.execute({}, ctx as any);
      expect(result).toBe("No scheduled tasks.");
    });

    it("lists tasks", async () => {
      const db = createMockDb();
      db.tasks.set("t1", {
        id: "t1", name: "my-task", type: "shell", schedule: "*/5 * * * *",
        payload: {}, enabled: true, oneShot: false, runCount: 3,
        nextRun: "2026-01-01T00:00:00Z", lastRun: "2025-12-31T23:55:00Z",
        status: "active", createdAt: "", updatedAt: "",
      } as ScheduledTask);
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "list_scheduled")!;

      const result = await tool.execute({}, ctx as any);
      expect(result).toContain("my-task");
      expect(result).toContain("runs: 3");
    });
  });

  describe("cancel_task", () => {
    it("cancels an existing task", async () => {
      const db = createMockDb();
      db.tasks.set("t1", {
        id: "t1", name: "cancel-me", type: "shell",
        payload: {}, enabled: true, oneShot: false, runCount: 0,
        status: "active", createdAt: "", updatedAt: "",
      } as ScheduledTask);
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "cancel_task")!;

      const result = await tool.execute({ task_id: "t1" }, ctx as any);
      expect(result).toContain("cancelled");
      expect(db.updateScheduledTaskStatus).toHaveBeenCalledWith("t1", "cancelled");
    });

    it("deletes a task permanently", async () => {
      const db = createMockDb();
      db.tasks.set("t1", {
        id: "t1", name: "delete-me", type: "shell",
        payload: {}, enabled: true, oneShot: false, runCount: 0,
        status: "active", createdAt: "", updatedAt: "",
      } as ScheduledTask);
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "cancel_task")!;

      const result = await tool.execute({ task_id: "t1", delete: true }, ctx as any);
      expect(result).toContain("permanently deleted");
      expect(db.deleteScheduledTask).toHaveBeenCalledWith("t1");
    });

    it("returns not found for unknown task", async () => {
      const db = createMockDb();
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "cancel_task")!;

      const result = await tool.execute({ task_id: "nope" }, ctx as any);
      expect(result).toContain("not found");
    });
  });

  describe("task_history", () => {
    it("shows no history", async () => {
      const db = createMockDb();
      db.tasks.set("t1", {
        id: "t1", name: "hist-task", type: "shell",
        payload: {}, enabled: true, oneShot: false, runCount: 0,
        status: "active", createdAt: "", updatedAt: "",
      } as ScheduledTask);
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "task_history")!;

      const result = await tool.execute({ task_id: "t1" }, ctx as any);
      expect(result).toContain("no execution history");
    });

    it("shows run history", async () => {
      const db = createMockDb();
      db.tasks.set("t1", {
        id: "t1", name: "hist-task", type: "shell",
        payload: {}, enabled: true, oneShot: false, runCount: 1,
        status: "active", createdAt: "", updatedAt: "",
      } as ScheduledTask);
      db.runs.push({
        id: "r1", taskId: "t1", startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z", success: true,
        result: "exit:0 stdout:hello", durationMs: 1000,
      });
      const ctx = createMockContext(db);
      const tool = tools.find((t) => t.name === "task_history")!;

      const result = await tool.execute({ task_id: "t1" }, ctx as any);
      expect(result).toContain("✓");
      expect(result).toContain("1000ms");
    });
  });
});
