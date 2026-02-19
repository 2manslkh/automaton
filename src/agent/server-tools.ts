/**
 * HTTP Server Tools — start_http_server, add_route, remove_route, list_servers, stop_server
 *
 * Lets automatons serve HTTP endpoints and earn money via x402 payment middleware.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type { AutomatonTool } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────

export interface RouteDefinition {
  path: string;
  method: string;
  status: number;
  body: string;
  contentType: string;
  filePath?: string;
  requirePayment?: boolean;
  paymentAmount?: number;
  paymentAddress?: string;
}

export interface RouteStats {
  requestCount: number;
  lastRequestAt: string | null;
}

export interface ManagedServer {
  port: number;
  server: http.Server;
  routes: Map<string, RouteDefinition>;
  stats: Map<string, RouteStats>;
  createdAt: string;
}

// ─── Server Registry (in-memory) ──────────────────────────────

const servers = new Map<number, ManagedServer>();

export function getServers(): Map<number, ManagedServer> {
  return servers;
}

// ─── Route Key ─────────────────────────────────────────────────

function routeKey(method: string, routePath: string): string {
  return `${method.toUpperCase()}:${routePath}`;
}

// ─── x402 Payment Verification ─────────────────────────────────

function verifyX402Payment(
  req: http.IncomingMessage,
  route: RouteDefinition,
): { valid: boolean; error?: string } {
  const paymentHeader = req.headers["x-payment"] || req.headers["x402-payment"];
  if (!paymentHeader) {
    return { valid: false, error: "Payment required. Include X-Payment header with x402 payment proof." };
  }

  // Basic verification: check header exists and is non-empty
  // In production, this would verify cryptographic proof against paymentAddress and paymentAmount
  const token = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
  if (!token || token.length < 10) {
    return { valid: false, error: "Invalid payment proof." };
  }

  return { valid: true };
}

// ─── Request Handler ───────────────────────────────────────────

function createRequestHandler(managed: ManagedServer) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = (req.method || "GET").toUpperCase();
    const url = req.url || "/";
    const key = routeKey(method, url);

    // Also try wildcard GET match
    const route = managed.routes.get(key) || managed.routes.get(routeKey("*", url));

    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Update stats
    const stats = managed.stats.get(key) || managed.stats.get(routeKey("*", url)) || { requestCount: 0, lastRequestAt: null };
    stats.requestCount++;
    stats.lastRequestAt = new Date().toISOString();
    managed.stats.set(routeKey(route.method, route.path), stats);

    // x402 payment check
    if (route.requirePayment) {
      const payment = verifyX402Payment(req, route);
      if (!payment.valid) {
        res.writeHead(402, {
          "Content-Type": "application/json",
          "X-Payment-Required": "true",
          "X-Payment-Amount": String(route.paymentAmount || 0),
          "X-Payment-Address": route.paymentAddress || "",
        });
        res.end(JSON.stringify({ error: payment.error }));
        return;
      }
    }

    // Serve file if filePath specified
    if (route.filePath) {
      const resolved = path.resolve(route.filePath);
      try {
        const content = fs.readFileSync(resolved);
        res.writeHead(route.status, { "Content-Type": route.contentType });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File not found" }));
      }
      return;
    }

    // Static response
    res.writeHead(route.status, { "Content-Type": route.contentType });
    res.end(route.body);
  };
}

// ─── Tools ─────────────────────────────────────────────────────

export function createServerTools(): AutomatonTool[] {
  return [
    {
      name: "start_http_server",
      description:
        "Start an HTTP server on a specified port with initial routes. Each route defines a path, method, response body, status code, and optional x402 payment requirement.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to listen on" },
          routes: {
            type: "array",
            description: "Array of route definitions",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "URL path (e.g., /api/data)" },
                method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE, or * for any (default: GET)" },
                status: { type: "number", description: "HTTP status code (default: 200)" },
                body: { type: "string", description: "Response body string" },
                content_type: { type: "string", description: "Content-Type header (default: application/json)" },
                file_path: { type: "string", description: "Serve a file instead of body" },
                require_payment: { type: "boolean", description: "Require x402 payment for this route" },
                payment_amount: { type: "number", description: "Payment amount in cents (for x402)" },
                payment_address: { type: "string", description: "Payment recipient address (for x402)" },
              },
              required: ["path"],
            },
          },
        },
        required: ["port"],
      },
      execute: async (args, _ctx) => {
        const port = args.port as number;

        if (servers.has(port)) {
          return `Error: Server already running on port ${port}. Stop it first.`;
        }

        if (port < 1 || port > 65535) {
          return "Error: Port must be between 1 and 65535.";
        }

        const managed: ManagedServer = {
          port,
          server: null as any,
          routes: new Map(),
          stats: new Map(),
          createdAt: new Date().toISOString(),
        };

        // Add initial routes
        const routeArgs = (args.routes as any[]) || [];
        for (const r of routeArgs) {
          const def: RouteDefinition = {
            path: r.path,
            method: (r.method || "GET").toUpperCase(),
            status: r.status || 200,
            body: r.body || "",
            contentType: r.content_type || "application/json",
            filePath: r.file_path,
            requirePayment: r.require_payment || false,
            paymentAmount: r.payment_amount,
            paymentAddress: r.payment_address,
          };
          const key = routeKey(def.method, def.path);
          managed.routes.set(key, def);
          managed.stats.set(key, { requestCount: 0, lastRequestAt: null });
        }

        return new Promise<string>((resolve) => {
          const server = http.createServer(createRequestHandler(managed));
          managed.server = server;

          server.on("error", (err: any) => {
            resolve(`Error starting server: ${err.message}`);
          });

          server.listen(port, () => {
            servers.set(port, managed);
            resolve(
              `HTTP server started on port ${port} with ${managed.routes.size} route(s). Use expose_port to make it publicly accessible.`,
            );
          });
        });
      },
    },

    {
      name: "add_route",
      description: "Add or update a route on a running HTTP server.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port of the running server" },
          path: { type: "string", description: "URL path" },
          method: { type: "string", description: "HTTP method (default: GET)" },
          status: { type: "number", description: "HTTP status code (default: 200)" },
          body: { type: "string", description: "Response body" },
          content_type: { type: "string", description: "Content-Type (default: application/json)" },
          file_path: { type: "string", description: "Serve a file instead of body" },
          require_payment: { type: "boolean", description: "Require x402 payment" },
          payment_amount: { type: "number", description: "Payment amount in cents" },
          payment_address: { type: "string", description: "Payment recipient address" },
        },
        required: ["port", "path"],
      },
      execute: async (args, _ctx) => {
        const port = args.port as number;
        const managed = servers.get(port);
        if (!managed) return `Error: No server running on port ${port}.`;

        const def: RouteDefinition = {
          path: args.path as string,
          method: ((args.method as string) || "GET").toUpperCase(),
          status: (args.status as number) || 200,
          body: (args.body as string) || "",
          contentType: (args.content_type as string) || "application/json",
          filePath: args.file_path as string | undefined,
          requirePayment: (args.require_payment as boolean) || false,
          paymentAmount: args.payment_amount as number | undefined,
          paymentAddress: args.payment_address as string | undefined,
        };

        const key = routeKey(def.method, def.path);
        const existed = managed.routes.has(key);
        managed.routes.set(key, def);
        if (!managed.stats.has(key)) {
          managed.stats.set(key, { requestCount: 0, lastRequestAt: null });
        }

        return `Route ${existed ? "updated" : "added"}: ${def.method} ${def.path} on port ${port}${def.requirePayment ? " (x402 payment required)" : ""}`;
      },
    },

    {
      name: "remove_route",
      description: "Remove a route from a running HTTP server.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port of the running server" },
          path: { type: "string", description: "URL path to remove" },
          method: { type: "string", description: "HTTP method (default: GET)" },
        },
        required: ["port", "path"],
      },
      execute: async (args, _ctx) => {
        const port = args.port as number;
        const managed = servers.get(port);
        if (!managed) return `Error: No server running on port ${port}.`;

        const method = ((args.method as string) || "GET").toUpperCase();
        const key = routeKey(method, args.path as string);

        if (!managed.routes.has(key)) {
          return `Error: Route ${method} ${args.path} not found on port ${port}.`;
        }

        managed.routes.delete(key);
        managed.stats.delete(key);
        return `Route removed: ${method} ${args.path} from port ${port}`;
      },
    },

    {
      name: "list_servers",
      description: "List all running HTTP servers with their routes and request counts.",
      category: "server" as any,
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        if (servers.size === 0) return "No servers running.";

        const lines: string[] = [];
        for (const [port, managed] of servers) {
          lines.push(`=== Server on port ${port} (started: ${managed.createdAt}) ===`);
          if (managed.routes.size === 0) {
            lines.push("  No routes configured.");
          }
          for (const [key, route] of managed.routes) {
            const stats = managed.stats.get(key) || { requestCount: 0, lastRequestAt: null };
            const paymentTag = route.requirePayment ? " [x402]" : "";
            const fileTag = route.filePath ? ` [file: ${route.filePath}]` : "";
            lines.push(
              `  ${route.method} ${route.path} → ${route.status}${paymentTag}${fileTag} | requests: ${stats.requestCount}${stats.lastRequestAt ? ` (last: ${stats.lastRequestAt})` : ""}`,
            );
          }
        }
        return lines.join("\n");
      },
    },

    {
      name: "stop_server",
      description: "Stop a running HTTP server.",
      category: "server" as any,
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port of the server to stop" },
        },
        required: ["port"],
      },
      execute: async (args, _ctx) => {
        const port = args.port as number;
        const managed = servers.get(port);
        if (!managed) return `Error: No server running on port ${port}.`;

        return new Promise<string>((resolve) => {
          managed.server.close(() => {
            const totalRequests = Array.from(managed.stats.values()).reduce(
              (sum, s) => sum + s.requestCount,
              0,
            );
            servers.delete(port);
            resolve(`Server on port ${port} stopped. Total requests served: ${totalRequests}`);
          });
        });
      },
    },
  ];
}
