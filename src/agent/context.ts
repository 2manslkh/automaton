/**
 * Context Window Management
 *
 * Manages the conversation history for the agent loop.
 * Uses token budgets for intelligent trimming and summarization.
 */

import type {
  ChatMessage,
  AgentTurn,
  AutomatonDatabase,
  InferenceClient,
  AgentState,
} from "../types.js";
import {
  estimateTokens,
  estimateMessagesTokens,
  TOKEN_BUDGETS,
  type BudgetMode,
} from "../utils/tokens.js";

const MAX_CONTEXT_TURNS = 20;
const SUMMARY_THRESHOLD = 15;

/**
 * Determine the budget mode from agent state.
 */
export function getBudgetMode(state?: AgentState): BudgetMode {
  if (state === "critical") return "critical";
  if (state === "low_compute") return "low_compute";
  return "normal";
}

/**
 * Build the message array for the next inference call.
 * Includes system prompt + recent conversation history.
 */
export function buildContextMessages(
  systemPrompt: string,
  recentTurns: AgentTurn[],
  pendingInput?: { content: string; source: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add recent turns as conversation history
  for (const turn of recentTurns) {
    if (turn.input) {
      messages.push({
        role: "user",
        content: `[${turn.inputSource || "system"}] ${turn.input}`,
      });
    }

    if (turn.thinking) {
      const msg: ChatMessage = {
        role: "assistant",
        content: turn.thinking,
      };

      if (turn.toolCalls.length > 0) {
        msg.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      messages.push(msg);

      for (const tc of turn.toolCalls) {
        messages.push({
          role: "tool",
          content: tc.error
            ? `Error: ${tc.error}`
            : tc.result,
          tool_call_id: tc.id,
        });
      }
    }
  }

  if (pendingInput) {
    messages.push({
      role: "user",
      content: `[${pendingInput.source}] ${pendingInput.content}`,
    });
  }

  return messages;
}

/**
 * Trim context to fit within token budget.
 * Uses token estimation to be smarter than simple turn counting.
 * Falls back to turn-count limit as a safety net.
 */
export function trimContext(
  turns: AgentTurn[],
  options?: {
    maxTurns?: number;
    systemPromptTokens?: number;
    state?: AgentState;
  },
): AgentTurn[] {
  const maxTurns = options?.maxTurns ?? MAX_CONTEXT_TURNS;
  const state = options?.state;
  const budgetMode = getBudgetMode(state);
  const tokenBudget = TOKEN_BUDGETS[budgetMode];
  const systemTokens = options?.systemPromptTokens ?? 0;

  // Available tokens for turns (reserve some for the response)
  const responseReserve = budgetMode === "critical" ? 2000 : 4000;
  const availableTokens = tokenBudget - systemTokens - responseReserve;

  if (availableTokens <= 0 || turns.length === 0) {
    // If system prompt alone exceeds budget, keep at most 2 recent turns
    return turns.slice(-2);
  }

  // First, apply hard turn limit
  let trimmed = turns.length > maxTurns ? turns.slice(-maxTurns) : [...turns];

  // Then, trim by token budget — remove oldest turns until we fit
  let totalTokens = estimateTurnsTokens(trimmed);

  while (trimmed.length > 1 && totalTokens > availableTokens) {
    trimmed.shift();
    totalTokens = estimateTurnsTokens(trimmed);
  }

  return trimmed;
}

/**
 * Estimate total tokens for an array of turns.
 */
export function estimateTurnsTokens(turns: AgentTurn[]): number {
  let total = 0;
  for (const turn of turns) {
    // Input message
    if (turn.input) {
      total += 4 + estimateTokens(`[${turn.inputSource || "system"}] ${turn.input}`);
    }
    // Thinking/assistant message
    if (turn.thinking) {
      total += 4 + estimateTokens(turn.thinking);
    }
    // Tool calls and results
    for (const tc of turn.toolCalls) {
      total += 4 + estimateTokens(tc.name);
      total += estimateTokens(JSON.stringify(tc.arguments));
      total += 4 + estimateTokens(tc.error ? `Error: ${tc.error}` : tc.result);
    }
  }
  return total;
}

/**
 * Summarize old turns into a compact context entry.
 * Includes tool results summary and active goals tracking.
 */
export async function summarizeTurns(
  turns: AgentTurn[],
  inference: InferenceClient,
): Promise<string> {
  if (turns.length === 0) return "No previous activity.";

  // Extract structured info from turns
  const toolUsage: Record<string, { ok: number; fail: number }> = {};
  const goals: Set<string> = new Set();
  const errors: string[] = [];

  for (const t of turns) {
    for (const tc of t.toolCalls) {
      if (!toolUsage[tc.name]) toolUsage[tc.name] = { ok: 0, fail: 0 };
      if (tc.error) {
        toolUsage[tc.name].fail++;
        errors.push(`${tc.name}: ${tc.error.slice(0, 80)}`);
      } else {
        toolUsage[tc.name].ok++;
      }
    }

    // Extract goals from thinking (look for goal-like patterns)
    const goalMatches = t.thinking.match(/(?:goal|objective|plan|todo|task)[:=]\s*(.+?)(?:\n|$)/gi);
    if (goalMatches) {
      for (const g of goalMatches) goals.add(g.trim().slice(0, 100));
    }
  }

  const toolSummary = Object.entries(toolUsage)
    .map(([name, counts]) => `${name}(✓${counts.ok}${counts.fail > 0 ? ` ✗${counts.fail}` : ""})`)
    .join(", ");

  const turnSummaries = turns.map((t) => {
    const tools = t.toolCalls
      .map((tc) => `${tc.name}(${tc.error ? "FAIL" : "ok"})`)
      .join(", ");
    const resultSnippets = t.toolCalls
      .filter((tc) => !tc.error && tc.result)
      .map((tc) => `${tc.name}→${tc.result.slice(0, 60)}`)
      .join("; ");
    return `[${t.timestamp}] ${t.inputSource || "self"}: ${t.thinking.slice(0, 120)}${tools ? ` | tools: ${tools}` : ""}${resultSnippets ? ` | results: ${resultSnippets}` : ""}`;
  });

  // Build the structured summary header
  const header = [
    `Turns: ${turns.length} (${turns[0].timestamp} → ${turns[turns.length - 1].timestamp})`,
    toolSummary ? `Tools used: ${toolSummary}` : null,
    errors.length > 0 ? `Errors: ${errors.slice(-3).join("; ")}` : null,
    goals.size > 0 ? `Active goals: ${[...goals].slice(0, 3).join("; ")}` : null,
  ].filter(Boolean).join("\n");

  // For few turns, return structured summary directly
  if (turns.length <= 5) {
    return `Previous activity summary:\n${header}\n${turnSummaries.join("\n")}`;
  }

  // For many turns, use inference to compress
  try {
    const response = await inference.chat([
      {
        role: "system",
        content:
          "Summarize the following agent activity into a concise paragraph. Include: what was accomplished, what failed, current goals, tool usage patterns, and important context for continuing work. Be specific about outcomes.",
      },
      {
        role: "user",
        content: `${header}\n\nDetailed log:\n${turnSummaries.join("\n")}`,
      },
    ], {
      maxTokens: 500,
      temperature: 0,
    });

    return `Previous activity summary:\n${header}\n\n${response.message.content}`;
  } catch {
    return `Previous activity summary:\n${header}\n${turnSummaries.slice(-5).join("\n")}`;
  }
}
