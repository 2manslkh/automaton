/**
 * Output Sanitizer
 *
 * Detects and redacts secrets from tool output before logging.
 * Patterns cover API keys, tokens, passwords, private keys, etc.
 */

export interface SanitizationResult {
  sanitized: string;
  redactedCount: number;
  patterns: string[];
}

interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  // Ethereum / EVM private keys (64 hex chars with 0x prefix)
  {
    name: "eth_private_key",
    pattern: /\b0x[0-9a-fA-F]{64}\b/g,
    replacement: "0x[REDACTED_PRIVATE_KEY]",
  },
  // Generic API keys (common formats)
  {
    name: "api_key_generic",
    pattern: /\b(?:sk|pk|api|key|token|secret|access)[_-]?[a-zA-Z0-9]{20,}\b/gi,
    replacement: "[REDACTED_API_KEY]",
  },
  // AWS keys
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    name: "aws_secret_key",
    pattern: /\b[0-9a-zA-Z/+=]{40}\b/g,
    replacement: "[REDACTED_AWS_SECRET]",
  },
  // Bearer tokens
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // JWT tokens
  {
    name: "jwt_token",
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  // GitHub tokens
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // OpenAI API keys
  {
    name: "openai_key",
    pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  // Anthropic API keys
  {
    name: "anthropic_key",
    pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  // Passwords in URLs
  {
    name: "url_password",
    pattern: /:\/\/([^:]+):([^@]{8,})@/g,
    replacement: "://$1:[REDACTED]@",
  },
  // Generic password/secret in key=value
  {
    name: "kv_secret",
    pattern: /(?:password|passwd|secret|token|apikey|api_key|private_key)\s*[=:]\s*["']?[^\s"',]{8,}/gi,
    replacement: "[REDACTED_KV_SECRET]",
  },
  // Base64-encoded secrets (long base64 strings that look like keys)
  {
    name: "base64_secret",
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    replacement: "[REDACTED_BASE64]",
  },
];

/**
 * Sanitize a string, redacting any detected secrets.
 */
export function sanitize(input: string): SanitizationResult {
  let result = input;
  let redactedCount = 0;
  const matchedPatterns: string[] = [];

  for (const { name, pattern, replacement } of REDACTION_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    const hasMatch = pattern.test(result);
    if (!hasMatch) continue;

    pattern.lastIndex = 0;
    const matches = result.match(pattern);
    if (matches) {
      redactedCount += matches.length;
      matchedPatterns.push(name);
    }

    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  return { sanitized: result, redactedCount, patterns: matchedPatterns };
}

/**
 * Quick check if a string likely contains secrets.
 */
export function containsSecrets(input: string): boolean {
  for (const { pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) return true;
  }
  return false;
}

/**
 * Sanitize specifically for wallet private keys.
 */
export function redactPrivateKeys(input: string): string {
  return input.replace(/\b0x[0-9a-fA-F]{64}\b/g, "0x[REDACTED_PRIVATE_KEY]");
}
