/**
 * Webhook Receiver System
 *
 * Register webhook endpoints, verify HMAC signatures, rate-limit,
 * queue events for agent processing, and optionally wake the agent.
 */

import * as crypto from "crypto";

// ─── Types ─────────────────────────────────────────────────────

export interface WebhookRegistration {
  id: string;
  path: string;
  secret?: string;
  eventFilter?: string[];
  shouldWake: boolean;
  createdAt: string;
  processor: string; // "github" | "stripe" | "generic"
}

export interface WebhookEvent {
  id: string;
  webhookId: string;
  timestamp: string;
  source: string;
  eventType: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  processed: boolean;
}

export interface WebhookStats {
  totalEvents: number;
  lastEventAt: string | null;
}

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

// ─── Constants ─────────────────────────────────────────────────

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WEBHOOK = 1000;

// ─── HMAC Verification ────────────────────────────────────────

export function computeHmac(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmacSignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = computeHmac(secret, payload);
  // Normalize: strip common prefixes like "sha256="
  const normalizedSig = signature.replace(/^sha256=/, "");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(normalizedSig, "hex"),
    );
  } catch {
    return false;
  }
}

// ─── Webhook Manager ──────────────────────────────────────────

export class WebhookManager {
  private webhooks: Map<string, WebhookRegistration> = new Map();
  private events: Map<string, WebhookEvent[]> = new Map();
  private stats: Map<string, WebhookStats> = new Map();
  private rateLimits: Map<string, RateLimitBucket> = new Map();
  private wakeCallback?: () => void;

  constructor(wakeCallback?: () => void) {
    this.wakeCallback = wakeCallback;
  }

  // ── Registration ──

  register(reg: Omit<WebhookRegistration, "id" | "createdAt">): WebhookRegistration {
    const id = crypto.randomUUID();
    const webhook: WebhookRegistration = {
      ...reg,
      id,
      createdAt: new Date().toISOString(),
    };
    this.webhooks.set(id, webhook);
    this.events.set(id, []);
    this.stats.set(id, { totalEvents: 0, lastEventAt: null });
    return webhook;
  }

  remove(id: string): boolean {
    if (!this.webhooks.has(id)) return false;
    this.webhooks.delete(id);
    this.events.delete(id);
    this.stats.delete(id);
    return true;
  }

  getById(id: string): WebhookRegistration | undefined {
    return this.webhooks.get(id);
  }

  findByPath(reqPath: string): WebhookRegistration | undefined {
    for (const wh of this.webhooks.values()) {
      if (reqPath === wh.path || reqPath === `/webhooks${wh.path}`) return wh;
    }
    return undefined;
  }

  listAll(): { webhook: WebhookRegistration; stats: WebhookStats }[] {
    const result: { webhook: WebhookRegistration; stats: WebhookStats }[] = [];
    for (const [id, webhook] of this.webhooks) {
      result.push({ webhook, stats: this.stats.get(id)! });
    }
    return result;
  }

  // ── Rate Limiting (unified) ──

  checkRateLimit(path: string): boolean {
    try {
      const { getQuotaManager } = require("../utils/quota-manager.js");
      return getQuotaManager().checkWebhook(path);
    } catch {
      // Fallback to built-in limiter if quota manager unavailable
      const now = Date.now();
      let bucket = this.rateLimits.get(path);
      if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
        bucket = { count: 0, windowStart: now };
        this.rateLimits.set(path, bucket);
      }
      bucket.count++;
      return bucket.count <= RATE_LIMIT_MAX;
    }
  }

  // ── Event Ingestion ──

  ingest(
    webhookId: string,
    eventType: string,
    payload: Record<string, unknown>,
    source: string,
  ): WebhookEvent | null {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) return null;

    // Event filter
    if (webhook.eventFilter && webhook.eventFilter.length > 0) {
      if (!webhook.eventFilter.includes(eventType)) return null;
    }

    const payloadStr = JSON.stringify(payload);
    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      webhookId,
      timestamp: new Date().toISOString(),
      source,
      eventType,
      payloadHash: crypto.createHash("sha256").update(payloadStr).digest("hex"),
      payload,
      processed: false,
    };

    const events = this.events.get(webhookId) || [];
    events.push(event);
    // Cap stored events
    if (events.length > MAX_EVENTS_PER_WEBHOOK) {
      events.splice(0, events.length - MAX_EVENTS_PER_WEBHOOK);
    }
    this.events.set(webhookId, events);

    const stats = this.stats.get(webhookId)!;
    stats.totalEvents++;
    stats.lastEventAt = event.timestamp;

    // Wake agent if configured
    if (webhook.shouldWake && this.wakeCallback) {
      this.wakeCallback();
    }

    return event;
  }

  getEvents(webhookId: string, limit = 50): WebhookEvent[] {
    const events = this.events.get(webhookId) || [];
    return events.slice(-limit);
  }

  getUnprocessedEvents(): WebhookEvent[] {
    const result: WebhookEvent[] = [];
    for (const events of this.events.values()) {
      for (const e of events) {
        if (!e.processed) result.push(e);
      }
    }
    return result;
  }

  markProcessed(eventId: string): void {
    for (const events of this.events.values()) {
      const event = events.find((e) => e.id === eventId);
      if (event) {
        event.processed = true;
        return;
      }
    }
  }

  // ── HTTP Handler ──

  handleRequest(
    reqPath: string,
    body: string,
    headers: Record<string, string | undefined>,
  ): { status: number; body: string } {
    const webhook = this.findByPath(reqPath);
    if (!webhook) {
      return { status: 404, body: JSON.stringify({ error: "Webhook not found" }) };
    }

    // Rate limit
    if (!this.checkRateLimit(webhook.path)) {
      return { status: 429, body: JSON.stringify({ error: "Rate limit exceeded" }) };
    }

    // HMAC verification
    if (webhook.secret) {
      const sig =
        headers["x-hub-signature-256"] ||
        headers["stripe-signature"] ||
        headers["x-webhook-signature"] ||
        "";
      if (!sig || !verifyHmacSignature(webhook.secret, body, sig)) {
        return { status: 401, body: JSON.stringify({ error: "Invalid signature" }) };
      }
    }

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return { status: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    // Determine event type from headers or payload
    const eventType =
      headers["x-github-event"] ||
      (payload.type as string) ||
      "unknown";

    const source =
      headers["x-github-delivery"] ||
      headers["stripe-webhook-id"] ||
      "unknown";

    const event = this.ingest(webhook.id, eventType, payload, source);
    if (!event) {
      return { status: 200, body: JSON.stringify({ filtered: true }) };
    }

    return { status: 200, body: JSON.stringify({ received: true, eventId: event.id }) };
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _manager: WebhookManager | undefined;

export function getWebhookManager(wakeCallback?: () => void): WebhookManager {
  if (!_manager) {
    _manager = new WebhookManager(wakeCallback);
  }
  return _manager;
}

export function resetWebhookManager(): void {
  _manager = undefined;
}
