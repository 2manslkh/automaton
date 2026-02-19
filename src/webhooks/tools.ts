/**
 * Webhook Tools — register_webhook, list_webhooks, webhook_events, remove_webhook
 */

import type { AutomatonTool } from "../types.js";
import { getWebhookManager } from "./handler.js";
import { processEvent } from "./processors.js";

export function createWebhookTools(): AutomatonTool[] {
  return [
    {
      name: "register_webhook",
      description:
        "Register a webhook endpoint. Returns the webhook ID and path. The webhook will be available at /webhooks/<path> on the agent's HTTP server.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "URL path for the webhook (e.g., /github)" },
          secret: { type: "string", description: "HMAC secret for signature verification (optional)" },
          event_filter: {
            type: "array",
            items: { type: "string" },
            description: "Only accept these event types (empty = accept all)",
          },
          should_wake: { type: "boolean", description: "Wake the agent when a webhook is received (default: false)" },
          processor: { type: "string", description: "Processor type: github, stripe, or generic (default: generic)" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const manager = getWebhookManager();
        const webhook = manager.register({
          path: args.path as string,
          secret: args.secret as string | undefined,
          eventFilter: (args.event_filter as string[]) || [],
          shouldWake: (args.should_wake as boolean) || false,
          processor: (args.processor as string) || "generic",
        });
        return JSON.stringify({
          id: webhook.id,
          path: webhook.path,
          fullPath: `/webhooks${webhook.path}`,
          processor: webhook.processor,
          hasSecret: !!webhook.secret,
          shouldWake: webhook.shouldWake,
        });
      },
    },

    {
      name: "list_webhooks",
      description: "List all registered webhooks with their stats.",
      category: "server" as any,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const manager = getWebhookManager();
        const all = manager.listAll();
        if (all.length === 0) return "No webhooks registered.";
        return JSON.stringify(
          all.map(({ webhook, stats }) => ({
            id: webhook.id,
            path: webhook.path,
            processor: webhook.processor,
            shouldWake: webhook.shouldWake,
            hasSecret: !!webhook.secret,
            totalEvents: stats.totalEvents,
            lastEventAt: stats.lastEventAt,
          })),
          null,
          2,
        );
      },
    },

    {
      name: "webhook_events",
      description: "View recent events for a webhook, optionally processed through the configured processor.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          webhook_id: { type: "string", description: "Webhook ID" },
          limit: { type: "number", description: "Max events to return (default: 20)" },
          processed: { type: "boolean", description: "Run events through processor for summaries (default: true)" },
        },
        required: ["webhook_id"],
      },
      execute: async (args) => {
        const manager = getWebhookManager();
        const webhookId = args.webhook_id as string;
        const webhook = manager.getById(webhookId);
        if (!webhook) return "Error: Webhook not found.";

        const limit = (args.limit as number) || 20;
        const events = manager.getEvents(webhookId, limit);
        if (events.length === 0) return "No events yet.";

        const shouldProcess = args.processed !== false;
        if (shouldProcess) {
          return JSON.stringify(
            events.map((e) => ({
              id: e.id,
              timestamp: e.timestamp,
              ...processEvent(webhook.processor, e),
              processed: e.processed,
            })),
            null,
            2,
          );
        }

        return JSON.stringify(
          events.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            eventType: e.eventType,
            source: e.source,
            payloadHash: e.payloadHash,
            processed: e.processed,
          })),
          null,
          2,
        );
      },
    },

    {
      name: "remove_webhook",
      description: "Remove a registered webhook endpoint.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          webhook_id: { type: "string", description: "Webhook ID to remove" },
        },
        required: ["webhook_id"],
      },
      execute: async (args) => {
        const manager = getWebhookManager();
        const removed = manager.remove(args.webhook_id as string);
        return removed
          ? "Webhook removed successfully."
          : "Error: Webhook not found.";
      },
    },
  ];
}
