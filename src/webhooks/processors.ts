/**
 * Pre-built Webhook Processors
 *
 * Extract structured data from common webhook sources.
 */

import type { WebhookEvent } from "./handler.js";

export interface ProcessedEvent {
  summary: string;
  eventType: string;
  actor?: string;
  details: Record<string, unknown>;
}

// ─── GitHub Processor ──────────────────────────────────────────

export function processGitHub(event: WebhookEvent): ProcessedEvent {
  const p = event.payload;

  switch (event.eventType) {
    case "push": {
      const commits = (p.commits as any[]) || [];
      const ref = (p.ref as string) || "";
      const branch = ref.replace("refs/heads/", "");
      const pusher = (p.pusher as any)?.name || "unknown";
      return {
        summary: `${pusher} pushed ${commits.length} commit(s) to ${branch}`,
        eventType: "push",
        actor: pusher,
        details: {
          branch,
          commitCount: commits.length,
          commitMessages: commits.map((c: any) => c.message),
          repository: (p.repository as any)?.full_name,
        },
      };
    }
    case "pull_request": {
      const pr = p.pull_request as any || {};
      const action = p.action as string || "unknown";
      const actor = (pr.user as any)?.login || "unknown";
      return {
        summary: `PR #${pr.number} "${pr.title}" ${action} by ${actor}`,
        eventType: "pull_request",
        actor,
        details: {
          action,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          repository: (p.repository as any)?.full_name,
        },
      };
    }
    case "issues": {
      const issue = p.issue as any || {};
      const action = p.action as string || "unknown";
      const actor = (issue.user as any)?.login || "unknown";
      return {
        summary: `Issue #${issue.number} "${issue.title}" ${action} by ${actor}`,
        eventType: "issues",
        actor,
        details: {
          action,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          repository: (p.repository as any)?.full_name,
        },
      };
    }
    default:
      return processGeneric(event);
  }
}

// ─── Stripe Processor ─────────────────────────────────────────

export function processStripe(event: WebhookEvent): ProcessedEvent {
  const p = event.payload;
  const type = (p.type as string) || event.eventType;
  const data = (p.data as any)?.object || {};

  switch (type) {
    case "payment_intent.succeeded": {
      const amount = data.amount || 0;
      const currency = data.currency || "usd";
      return {
        summary: `Payment received: ${amount / 100} ${currency.toUpperCase()}`,
        eventType: "payment_received",
        details: { amount, currency, paymentIntentId: data.id, customerId: data.customer },
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const action = type.split(".").pop()!;
      return {
        summary: `Subscription ${action}: ${data.id}`,
        eventType: `subscription_${action}`,
        details: { subscriptionId: data.id, status: data.status, customerId: data.customer },
      };
    }
    default:
      return {
        summary: `Stripe event: ${type}`,
        eventType: type,
        details: { rawType: type, objectId: data.id },
      };
  }
}

// ─── Generic Processor ────────────────────────────────────────

export function processGeneric(event: WebhookEvent): ProcessedEvent {
  return {
    summary: `Webhook event: ${event.eventType} from ${event.source}`,
    eventType: event.eventType,
    details: event.payload,
  };
}

// ─── Router ────────────────────────────────────────────────────

export function processEvent(processorName: string, event: WebhookEvent): ProcessedEvent {
  switch (processorName) {
    case "github":
      return processGitHub(event);
    case "stripe":
      return processStripe(event);
    default:
      return processGeneric(event);
  }
}
