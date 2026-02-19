/**
 * Token Estimation Utility
 *
 * Approximate token counts using cl100k-style heuristics.
 * No tiktoken dependency needed — good enough for budget management.
 */

/**
 * Estimate token count for a string using cl100k-style heuristics.
 *
 * Rules of thumb for cl100k_base:
 * - ~1 token per 4 characters of English text
 * - Common words are usually 1 token
 * - Whitespace and punctuation often get their own tokens
 * - Code/special chars tend to use more tokens per character
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Base: ~1 token per 4 chars (good average for English)
  let estimate = text.length / 4;

  // Adjust for special characters (they often tokenize individually)
  const specialChars = text.match(/[^a-zA-Z0-9\s]/g);
  if (specialChars) {
    estimate += specialChars.length * 0.3;
  }

  // Adjust for numbers (digits often tokenize in groups of 1-3)
  const numbers = text.match(/\d+/g);
  if (numbers) {
    for (const num of numbers) {
      estimate += Math.ceil(num.length / 3) * 0.2;
    }
  }

  return Math.ceil(estimate);
}

/**
 * Estimate tokens for a ChatMessage array (system + user + assistant + tool messages).
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }>,
): number {
  let total = 0;

  for (const msg of messages) {
    // Per-message overhead (~4 tokens for role, separators)
    total += 4;

    if (msg.content) {
      total += estimateTokens(msg.content);
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += 4; // tool call overhead
        if (tc.function?.name) total += estimateTokens(tc.function.name);
        if (tc.function?.arguments) total += estimateTokens(tc.function.arguments);
      }
    }

    if (msg.tool_call_id) {
      total += estimateTokens(msg.tool_call_id);
    }
  }

  // Conversation overhead
  total += 3;

  return Math.ceil(total);
}

/**
 * Token budget constants for different modes.
 */
export const TOKEN_BUDGETS = {
  /** Normal operation — generous context */
  normal: 80_000,
  /** Low compute mode — save tokens/cost */
  low_compute: 30_000,
  /** Critical mode — minimal context */
  critical: 15_000,
} as const;

export type BudgetMode = keyof typeof TOKEN_BUDGETS;
