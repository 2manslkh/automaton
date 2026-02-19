/**
 * Retry utility with exponential backoff, jitter, and circuit breaker.
 */

export interface RetryOptions {
  /** Max number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Overall timeout in ms (default: 60000). 0 = no timeout. */
  timeoutMs?: number;
  /** Which errors are retryable (default: transient HTTP errors) */
  isRetryable?: (error: unknown) => boolean;
  /** Called on each retry attempt */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Check if an error is a transient/retryable failure.
 * Matches network errors, 429 (rate limit), 502/503/504 (server errors).
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network-level failures
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("socket hang up") ||
      msg.includes("network") ||
      msg.includes("abort")
    ) {
      return true;
    }
    // HTTP status codes in error messages
    if (/\b(429|502|503|504)\b/.test(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  // Add jitter: random between 50%-100% of calculated delay
  const jitter = capped * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}

/**
 * Execute an async function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    timeoutMs = 60_000,
    isRetryable = isTransientError,
    onRetry,
  } = options;

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (timeoutMs > 0 && Date.now() >= deadline) {
        throw new RetryTimeoutError(
          `Retry timeout after ${timeoutMs}ms`,
          lastError,
        );
      }
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);

      // Don't wait past deadline
      if (timeoutMs > 0 && Date.now() + delay >= deadline) {
        throw new RetryTimeoutError(
          `Retry timeout after ${timeoutMs}ms`,
          error,
        );
      }

      onRetry?.(attempt + 1, error, delay);
      await sleep(delay);
    }
  }

  // Should not reach here
  throw lastError;
}

export class RetryTimeoutError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RetryTimeoutError";
    this.cause = cause;
  }
}

// ─── Circuit Breaker ─────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Ms to wait before trying half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Max reset timeout after repeated trips (default: 300000) */
  maxResetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private consecutiveTrips = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly maxResetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.maxResetTimeoutMs = options.maxResetTimeoutMs ?? 300_000;
  }

  /** Execute fn through the circuit breaker. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const currentResetTimeout = Math.min(
        this.resetTimeoutMs * Math.pow(2, this.consecutiveTrips - 1),
        this.maxResetTimeoutMs,
      );
      if (Date.now() - this.lastFailureTime >= currentResetTimeout) {
        this.state = "half-open";
      } else {
        throw new CircuitOpenError(
          `Circuit breaker is open. Next attempt in ${Math.ceil((this.lastFailureTime + currentResetTimeout - Date.now()) / 1000)}s`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.consecutiveTrips = 0;
    }
    this.failureCount = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open" || this.failureCount >= this.failureThreshold) {
      if (this.state !== "open") {
        this.consecutiveTrips++;
      }
      this.state = "open";
      this.failureCount = 0;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.consecutiveTrips = 0;
    this.lastFailureTime = 0;
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };
