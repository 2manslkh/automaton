/**
 * Context Management Tests
 */

import { describe, it, expect } from "vitest";
import { buildContextMessages, trimContext, summarizeTurns, estimateTurnsTokens, getBudgetMode } from "../agent/context.js";
import { estimateTokens, estimateMessagesTokens, TOKEN_BUDGETS } from "../utils/tokens.js";
import { MockInferenceClient, noToolResponse } from "./mocks.js";
import type { AgentTurn } from "../types.js";

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: `turn_${Date.now()}_${Math.random()}`,
    timestamp: new Date().toISOString(),
    state: "running",
    input: "",
    inputSource: "system",
    thinking: "I should do something",
    toolCalls: [],
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costCents: 1,
    ...overrides,
  };
}

function makeLargeTurn(thinkingSize: number): AgentTurn {
  return makeTurn({
    thinking: "x".repeat(thinkingSize),
    input: "y".repeat(thinkingSize / 2),
  });
}

describe("Token Estimation", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("estimates roughly 1 token per 4 chars for plain English", () => {
      const text = "Hello world this is a test sentence for tokens";
      const estimate = estimateTokens(text);
      // ~47 chars / 4 = ~12, plus minor adjustments
      expect(estimate).toBeGreaterThan(8);
      expect(estimate).toBeLessThan(25);
    });

    it("adds extra for special characters", () => {
      const plain = "hello world";
      const special = "he!!o w@r#d";
      expect(estimateTokens(special)).toBeGreaterThan(estimateTokens(plain));
    });

    it("handles code-like content", () => {
      const code = 'const x = { foo: "bar", baz: [1, 2, 3] };';
      const estimate = estimateTokens(code);
      expect(estimate).toBeGreaterThan(5);
    });

    it("handles numbers", () => {
      const nums = "1234567890 42 999999";
      const estimate = estimateTokens(nums);
      expect(estimate).toBeGreaterThan(3);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("includes per-message overhead", () => {
      const messages = [
        { role: "system", content: "You are a bot." },
        { role: "user", content: "Hi" },
      ];
      const tokens = estimateMessagesTokens(messages);
      // Should be more than just content tokens
      expect(tokens).toBeGreaterThan(estimateTokens("You are a bot.Hi"));
    });

    it("accounts for tool calls", () => {
      const withoutTools = [{ role: "assistant", content: "thinking" }];
      const withTools = [{
        role: "assistant",
        content: "thinking",
        tool_calls: [{ function: { name: "exec", arguments: '{"command":"ls"}' } }],
      }];
      expect(estimateMessagesTokens(withTools)).toBeGreaterThan(estimateMessagesTokens(withoutTools));
    });
  });
});

describe("Budget Mode", () => {
  it("returns normal for running state", () => {
    expect(getBudgetMode("running")).toBe("normal");
  });

  it("returns low_compute for low_compute state", () => {
    expect(getBudgetMode("low_compute")).toBe("low_compute");
  });

  it("returns critical for critical state", () => {
    expect(getBudgetMode("critical")).toBe("critical");
  });

  it("returns normal for undefined", () => {
    expect(getBudgetMode(undefined)).toBe("normal");
  });
});

describe("Context Management", () => {
  describe("buildContextMessages", () => {
    it("starts with system prompt", () => {
      const msgs = buildContextMessages("You are a bot.", []);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].content).toBe("You are a bot.");
    });

    it("includes turn input as user message", () => {
      const turns = [makeTurn({ input: "hello", inputSource: "agent", thinking: "hi" })];
      const msgs = buildContextMessages("sys", turns);
      const userMsg = msgs.find(m => m.role === "user");
      expect(userMsg?.content).toContain("hello");
      expect(userMsg?.content).toContain("agent");
    });

    it("includes assistant thinking", () => {
      const turns = [makeTurn({ thinking: "Let me think about this" })];
      const msgs = buildContextMessages("sys", turns);
      const assistantMsg = msgs.find(m => m.role === "assistant");
      expect(assistantMsg?.content).toBe("Let me think about this");
    });

    it("includes tool calls and results", () => {
      const turns = [makeTurn({
        thinking: "Running exec",
        toolCalls: [{
          id: "call_1",
          name: "exec",
          arguments: { command: "ls" },
          result: "file.txt",
          durationMs: 100,
        }],
      })];
      const msgs = buildContextMessages("sys", turns);
      const toolMsg = msgs.find(m => m.role === "tool");
      expect(toolMsg?.content).toBe("file.txt");
      expect(toolMsg?.tool_call_id).toBe("call_1");

      const assistantMsg = msgs.find(m => m.role === "assistant");
      expect(assistantMsg?.tool_calls).toHaveLength(1);
    });

    it("includes tool error", () => {
      const turns = [makeTurn({
        thinking: "fail",
        toolCalls: [{
          id: "call_1",
          name: "exec",
          arguments: {},
          result: "",
          error: "command failed",
          durationMs: 50,
        }],
      })];
      const msgs = buildContextMessages("sys", turns);
      const toolMsg = msgs.find(m => m.role === "tool");
      expect(toolMsg?.content).toContain("Error: command failed");
    });

    it("appends pending input", () => {
      const msgs = buildContextMessages("sys", [], { content: "urgent!", source: "human" });
      expect(msgs).toHaveLength(2);
      expect(msgs[1].role).toBe("user");
      expect(msgs[1].content).toContain("urgent!");
      expect(msgs[1].content).toContain("human");
    });

    it("skips turn input when empty", () => {
      const turns = [makeTurn({ input: "", thinking: "thinking" })];
      const msgs = buildContextMessages("sys", turns);
      const userMsgs = msgs.filter(m => m.role === "user");
      expect(userMsgs).toHaveLength(0);
    });
  });

  describe("trimContext", () => {
    it("returns all turns when under limit", () => {
      const turns = [makeTurn(), makeTurn(), makeTurn()];
      expect(trimContext(turns, { maxTurns: 5 })).toHaveLength(3);
    });

    it("trims to most recent turns by maxTurns", () => {
      const turns = Array.from({ length: 30 }, (_, i) =>
        makeTurn({ thinking: `turn ${i}` })
      );
      const trimmed = trimContext(turns, { maxTurns: 10 });
      expect(trimmed).toHaveLength(10);
      expect(trimmed[0].thinking).toBe("turn 20");
      expect(trimmed[9].thinking).toBe("turn 29");
    });

    it("uses default max of 20", () => {
      const turns = Array.from({ length: 25 }, () => makeTurn());
      const trimmed = trimContext(turns);
      expect(trimmed).toHaveLength(20);
    });

    it("trims by token budget when system prompt is large", () => {
      // Each large turn is ~1000+ tokens
      const turns = Array.from({ length: 10 }, () => makeLargeTurn(4000));
      const trimmed = trimContext(turns, {
        systemPromptTokens: 70_000,
        state: "running",
      });
      // With 80k budget - 70k system - 4k reserve = 6k available
      // Should trim significantly
      expect(trimmed.length).toBeLessThan(10);
      expect(trimmed.length).toBeGreaterThan(0);
    });

    it("uses smaller budget in low_compute mode", () => {
      const turns = Array.from({ length: 20 }, () => makeTurn({ thinking: "x".repeat(500) }));
      const normalTrimmed = trimContext(turns, { state: "running" });
      const lowTrimmed = trimContext(turns, { state: "low_compute" });
      expect(lowTrimmed.length).toBeLessThanOrEqual(normalTrimmed.length);
    });

    it("uses smallest budget in critical mode", () => {
      const turns = Array.from({ length: 20 }, () => makeTurn({ thinking: "x".repeat(500) }));
      const lowTrimmed = trimContext(turns, { state: "low_compute" });
      const criticalTrimmed = trimContext(turns, { state: "critical" });
      expect(criticalTrimmed.length).toBeLessThanOrEqual(lowTrimmed.length);
    });

    it("keeps at least 1 turn even when over budget", () => {
      const turns = [makeLargeTurn(10000)];
      const trimmed = trimContext(turns, {
        systemPromptTokens: 79_000,
        state: "running",
      });
      expect(trimmed.length).toBe(1);
    });

    it("returns at most 2 turns when system prompt exceeds budget", () => {
      const turns = Array.from({ length: 5 }, () => makeTurn());
      const trimmed = trimContext(turns, {
        systemPromptTokens: 100_000, // exceeds 80k budget
        state: "running",
      });
      expect(trimmed.length).toBeLessThanOrEqual(2);
    });
  });

  describe("estimateTurnsTokens", () => {
    it("returns 0 for empty array", () => {
      expect(estimateTurnsTokens([])).toBe(0);
    });

    it("counts input, thinking, and tool calls", () => {
      const turns = [makeTurn({
        input: "hello world",
        thinking: "let me think",
        toolCalls: [{
          id: "1",
          name: "exec",
          arguments: { command: "ls" },
          result: "file.txt",
          durationMs: 50,
        }],
      })];
      const tokens = estimateTurnsTokens(turns);
      expect(tokens).toBeGreaterThan(10);
    });
  });

  describe("summarizeTurns", () => {
    it("returns no activity for empty", async () => {
      const inference = new MockInferenceClient();
      const result = await summarizeTurns([], inference);
      expect(result).toBe("No previous activity.");
    });

    it("returns direct summary for <= 5 turns", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({ thinking: "did something", inputSource: "system" })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("Previous activity summary");
      expect(result).toContain("did something");
      expect(inference.calls).toHaveLength(0);
    });

    it("uses inference for > 5 turns", async () => {
      const inference = new MockInferenceClient([noToolResponse("Summary of activity.")]);
      const turns = Array.from({ length: 6 }, () => makeTurn({ thinking: "work" }));
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("Summary of activity");
      expect(inference.calls).toHaveLength(1);
    });

    it("falls back on inference error", async () => {
      const inference = new MockInferenceClient();
      inference.chat = async () => { throw new Error("fail"); };
      const turns = Array.from({ length: 6 }, () => makeTurn({ thinking: "work" }));
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("Previous activity summary");
    });

    it("includes tool usage summary", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({
        thinking: "ran a command",
        toolCalls: [{ id: "1", name: "exec", arguments: {}, result: "ok", durationMs: 50 }],
      })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("exec");
    });

    it("shows FAIL for errored tool calls", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({
        thinking: "tried something",
        toolCalls: [{ id: "1", name: "exec", arguments: {}, result: "", error: "boom", durationMs: 50 }],
      })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("FAIL");
    });

    it("includes tool result snippets", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({
        thinking: "checking files",
        toolCalls: [{ id: "1", name: "exec", arguments: {}, result: "important_file.txt", durationMs: 50 }],
      })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("important_file.txt");
    });

    it("tracks tool success/failure counts", async () => {
      const inference = new MockInferenceClient();
      const turns = [
        makeTurn({
          thinking: "t1",
          toolCalls: [
            { id: "1", name: "exec", arguments: {}, result: "ok", durationMs: 50 },
            { id: "2", name: "exec", arguments: {}, result: "", error: "fail", durationMs: 50 },
          ],
        }),
        makeTurn({
          thinking: "t2",
          toolCalls: [
            { id: "3", name: "exec", arguments: {}, result: "ok", durationMs: 50 },
          ],
        }),
      ];
      const result = await summarizeTurns(turns, inference);
      // Should show exec with 2 ok and 1 fail
      expect(result).toContain("✓2");
      expect(result).toContain("✗1");
    });
  });
});
