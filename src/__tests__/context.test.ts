/**
 * Context Management Tests
 */

import { describe, it, expect } from "vitest";
import { buildContextMessages, trimContext, summarizeTurns } from "../agent/context.js";
import { MockInferenceClient, noToolResponse } from "./mocks.js";
import type { AgentTurn } from "../types.js";

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: `turn_${Date.now()}_${Math.random()}`,
    timestamp: new Date().toISOString(),
    input: "",
    inputSource: "system",
    thinking: "I should do something",
    toolCalls: [],
    ...overrides,
  };
}

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
      expect(trimContext(turns, 5)).toHaveLength(3);
    });

    it("trims to most recent turns", () => {
      const turns = Array.from({ length: 30 }, (_, i) =>
        makeTurn({ thinking: `turn ${i}` })
      );
      const trimmed = trimContext(turns, 10);
      expect(trimmed).toHaveLength(10);
      expect(trimmed[0].thinking).toBe("turn 20");
      expect(trimmed[9].thinking).toBe("turn 29");
    });

    it("uses default max of 20", () => {
      const turns = Array.from({ length: 25 }, () => makeTurn());
      const trimmed = trimContext(turns);
      expect(trimmed).toHaveLength(20);
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
      expect(inference.calls).toHaveLength(0); // no inference call
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
      // Override chat to throw
      inference.chat = async () => { throw new Error("fail"); };
      const turns = Array.from({ length: 6 }, () => makeTurn({ thinking: "work" }));
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("Previous activity summary");
    });

    it("includes tool call info in summaries", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({
        thinking: "ran a command",
        toolCalls: [{ id: "1", name: "exec", arguments: {}, result: "ok" }],
      })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("exec(ok)");
    });

    it("shows FAILED for errored tool calls", async () => {
      const inference = new MockInferenceClient();
      const turns = [makeTurn({
        thinking: "tried something",
        toolCalls: [{ id: "1", name: "exec", arguments: {}, result: "", error: "boom" }],
      })];
      const result = await summarizeTurns(turns, inference);
      expect(result).toContain("exec(FAILED)");
    });
  });
});
