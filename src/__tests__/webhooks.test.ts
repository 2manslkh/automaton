/**
 * Webhook System Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  WebhookManager,
  computeHmac,
  verifyHmacSignature,
} from "../webhooks/handler.js";
import { processGitHub, processStripe, processGeneric } from "../webhooks/processors.js";
import type { WebhookEvent } from "../webhooks/handler.js";

describe("HMAC Verification", () => {
  const secret = "test-secret-123";
  const payload = '{"action":"push"}';

  it("should compute a valid HMAC", () => {
    const hmac = computeHmac(secret, payload);
    expect(hmac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should verify a correct signature", () => {
    const sig = computeHmac(secret, payload);
    expect(verifyHmacSignature(secret, payload, sig)).toBe(true);
  });

  it("should verify with sha256= prefix", () => {
    const sig = computeHmac(secret, payload);
    expect(verifyHmacSignature(secret, payload, `sha256=${sig}`)).toBe(true);
  });

  it("should reject an incorrect signature", () => {
    expect(verifyHmacSignature(secret, payload, "deadbeef".repeat(8))).toBe(false);
  });

  it("should reject a malformed signature", () => {
    expect(verifyHmacSignature(secret, payload, "not-hex")).toBe(false);
  });
});

describe("Rate Limiting", () => {
  let manager: WebhookManager;

  beforeEach(() => {
    manager = new WebhookManager();
  });

  it("should allow requests under the limit", () => {
    for (let i = 0; i < 60; i++) {
      expect(manager.checkRateLimit("/test")).toBe(true);
    }
  });

  it("should block requests over the limit", () => {
    for (let i = 0; i < 60; i++) {
      manager.checkRateLimit("/test");
    }
    expect(manager.checkRateLimit("/test")).toBe(false);
  });

  it("should track paths independently", () => {
    for (let i = 0; i < 60; i++) {
      manager.checkRateLimit("/a");
    }
    expect(manager.checkRateLimit("/a")).toBe(false);
    expect(manager.checkRateLimit("/b")).toBe(true);
  });
});

describe("Event Queuing", () => {
  let manager: WebhookManager;

  beforeEach(() => {
    manager = new WebhookManager();
  });

  it("should register and ingest events", () => {
    const wh = manager.register({ path: "/test", shouldWake: false, processor: "generic" });
    const event = manager.ingest(wh.id, "test.event", { data: 1 }, "source-1");
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("test.event");
    expect(event!.processed).toBe(false);
  });

  it("should filter events by eventFilter", () => {
    const wh = manager.register({
      path: "/filtered",
      shouldWake: false,
      processor: "generic",
      eventFilter: ["push"],
    });
    const accepted = manager.ingest(wh.id, "push", { data: 1 }, "s");
    const rejected = manager.ingest(wh.id, "issues", { data: 1 }, "s");
    expect(accepted).not.toBeNull();
    expect(rejected).toBeNull();
  });

  it("should return unprocessed events", () => {
    const wh = manager.register({ path: "/q", shouldWake: false, processor: "generic" });
    manager.ingest(wh.id, "a", {}, "s");
    manager.ingest(wh.id, "b", {}, "s");
    const unprocessed = manager.getUnprocessedEvents();
    expect(unprocessed).toHaveLength(2);
    manager.markProcessed(unprocessed[0].id);
    expect(manager.getUnprocessedEvents()).toHaveLength(1);
  });

  it("should call wakeCallback when shouldWake is true", () => {
    let woken = false;
    const mgr = new WebhookManager(() => { woken = true; });
    const wh = mgr.register({ path: "/wake", shouldWake: true, processor: "generic" });
    mgr.ingest(wh.id, "test", {}, "s");
    expect(woken).toBe(true);
  });

  it("should handle full HTTP request flow", () => {
    const secret = "my-secret";
    const wh = manager.register({ path: "/gh", secret, shouldWake: false, processor: "github" });
    const payload = JSON.stringify({ ref: "refs/heads/main", commits: [], pusher: { name: "bot" } });
    const sig = computeHmac(secret, payload);

    const result = manager.handleRequest("/webhooks/gh", payload, {
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-event": "push",
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).received).toBe(true);
  });

  it("should reject invalid signature", () => {
    const wh = manager.register({ path: "/sec", secret: "s", shouldWake: false, processor: "generic" });
    const result = manager.handleRequest("/webhooks/sec", '{"a":1}', {
      "x-webhook-signature": "bad",
    });
    expect(result.status).toBe(401);
  });

  it("should return 429 when rate limited", () => {
    manager.register({ path: "/rl", shouldWake: false, processor: "generic" });
    for (let i = 0; i < 61; i++) {
      manager.handleRequest("/webhooks/rl", '{}', {});
    }
    const result = manager.handleRequest("/webhooks/rl", '{}', {});
    // After 62 requests total (61 in loop + 1), should be rate limited
    // Actually the 62nd call - let's just check the result
    expect(result.status).toBe(429);
  });
});

describe("GitHub Processor", () => {
  const makeEvent = (eventType: string, payload: Record<string, unknown>): WebhookEvent => ({
    id: "e1",
    webhookId: "w1",
    timestamp: new Date().toISOString(),
    source: "github",
    eventType,
    payloadHash: "abc",
    payload,
    processed: false,
  });

  it("should process push events", () => {
    const result = processGitHub(
      makeEvent("push", {
        ref: "refs/heads/main",
        commits: [{ message: "fix: bug" }, { message: "feat: new" }],
        pusher: { name: "alice" },
        repository: { full_name: "org/repo" },
      }),
    );
    expect(result.summary).toContain("alice");
    expect(result.summary).toContain("2 commit(s)");
    expect(result.summary).toContain("main");
    expect(result.details.commitMessages).toHaveLength(2);
  });

  it("should process pull_request events", () => {
    const result = processGitHub(
      makeEvent("pull_request", {
        action: "opened",
        pull_request: { number: 42, title: "Add feature", state: "open", user: { login: "bob" } },
        repository: { full_name: "org/repo" },
      }),
    );
    expect(result.summary).toContain("PR #42");
    expect(result.summary).toContain("bob");
    expect(result.actor).toBe("bob");
  });

  it("should process issues events", () => {
    const result = processGitHub(
      makeEvent("issues", {
        action: "closed",
        issue: { number: 10, title: "Bug report", state: "closed", user: { login: "carol" } },
        repository: { full_name: "org/repo" },
      }),
    );
    expect(result.summary).toContain("Issue #10");
    expect(result.summary).toContain("closed");
  });

  it("should fall back to generic for unknown events", () => {
    const result = processGitHub(makeEvent("star", { action: "created" }));
    expect(result.eventType).toBe("star");
  });
});

describe("Stripe Processor", () => {
  const makeEvent = (type: string, data: any): WebhookEvent => ({
    id: "e1",
    webhookId: "w1",
    timestamp: new Date().toISOString(),
    source: "stripe",
    eventType: type,
    payloadHash: "abc",
    payload: { type, data: { object: data } },
    processed: false,
  });

  it("should process payment_intent.succeeded", () => {
    const result = processStripe(
      makeEvent("payment_intent.succeeded", { id: "pi_1", amount: 5000, currency: "usd", customer: "cus_1" }),
    );
    expect(result.summary).toContain("50");
    expect(result.summary).toContain("USD");
    expect(result.eventType).toBe("payment_received");
  });

  it("should process subscription events", () => {
    const result = processStripe(
      makeEvent("customer.subscription.created", { id: "sub_1", status: "active", customer: "cus_1" }),
    );
    expect(result.summary).toContain("Subscription created");
    expect(result.eventType).toBe("subscription_created");
  });
});
