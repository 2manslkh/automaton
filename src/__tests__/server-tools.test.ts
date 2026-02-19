import { describe, it, expect, afterEach } from "vitest";
import { createServerTools, getServers } from "../agent/server-tools.js";
import type { AutomatonTool } from "../types.js";
import http from "http";

const tools = createServerTools();
const dummyCtx = {} as any;

function getTool(name: string): AutomatonTool {
  return tools.find((t) => t.name === name)!;
}

function fetch402(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  // Stop all servers after each test
  for (const [port] of getServers()) {
    await getTool("stop_server").execute({ port }, dummyCtx);
  }
});

describe("start_http_server", () => {
  it("starts a server and serves a route", async () => {
    const result = await getTool("start_http_server").execute(
      {
        port: 18901,
        routes: [{ path: "/hello", method: "GET", body: '{"msg":"hi"}', status: 200 }],
      },
      dummyCtx,
    );
    expect(result).toContain("started on port 18901");
    expect(result).toContain("1 route(s)");

    const res = await fetch402(18901, "/hello");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ msg: "hi" });
  });

  it("returns 404 for unknown route", async () => {
    await getTool("start_http_server").execute({ port: 18902, routes: [] }, dummyCtx);
    const res = await fetch402(18902, "/nope");
    expect(res.status).toBe(404);
  });

  it("rejects duplicate port", async () => {
    await getTool("start_http_server").execute({ port: 18903, routes: [] }, dummyCtx);
    const result = await getTool("start_http_server").execute({ port: 18903, routes: [] }, dummyCtx);
    expect(result).toContain("already running");
  });
});

describe("add_route / remove_route", () => {
  it("adds a route dynamically", async () => {
    await getTool("start_http_server").execute({ port: 18904, routes: [] }, dummyCtx);
    const result = await getTool("add_route").execute(
      { port: 18904, path: "/new", body: "ok" },
      dummyCtx,
    );
    expect(result).toContain("added");

    const res = await fetch402(18904, "/new");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("removes a route", async () => {
    await getTool("start_http_server").execute(
      { port: 18905, routes: [{ path: "/bye", body: "gone" }] },
      dummyCtx,
    );
    await getTool("remove_route").execute({ port: 18905, path: "/bye" }, dummyCtx);
    const res = await fetch402(18905, "/bye");
    expect(res.status).toBe(404);
  });
});

describe("request counting", () => {
  it("tracks request counts per route", async () => {
    await getTool("start_http_server").execute(
      { port: 18906, routes: [{ path: "/count", body: "x" }] },
      dummyCtx,
    );

    await fetch402(18906, "/count");
    await fetch402(18906, "/count");
    await fetch402(18906, "/count");

    const result = await getTool("list_servers").execute({}, dummyCtx);
    expect(result).toContain("requests: 3");
  });
});

describe("x402 payment middleware", () => {
  it("returns 402 when payment required but missing", async () => {
    await getTool("start_http_server").execute(
      {
        port: 18907,
        routes: [
          {
            path: "/paid",
            body: "premium content",
            require_payment: true,
            payment_amount: 100,
            payment_address: "0xabc",
          },
        ],
      },
      dummyCtx,
    );

    const res = await fetch402(18907, "/paid");
    expect(res.status).toBe(402);
    expect(res.headers["x-payment-required"]).toBe("true");
  });

  it("serves content when valid payment header present", async () => {
    await getTool("start_http_server").execute(
      {
        port: 18908,
        routes: [{ path: "/paid", body: "premium", require_payment: true }],
      },
      dummyCtx,
    );

    const res = await fetch402(18908, "/paid", { "X-Payment": "valid-payment-proof-token-here" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("premium");
  });
});

describe("list_servers", () => {
  it("shows no servers when none running", async () => {
    const result = await getTool("list_servers").execute({}, dummyCtx);
    expect(result).toBe("No servers running.");
  });
});

describe("stop_server", () => {
  it("stops a server and reports total requests", async () => {
    await getTool("start_http_server").execute(
      { port: 18909, routes: [{ path: "/x", body: "y" }] },
      dummyCtx,
    );
    await fetch402(18909, "/x");

    const result = await getTool("stop_server").execute({ port: 18909 }, dummyCtx);
    expect(result).toContain("stopped");
    expect(result).toContain("Total requests served: 1");
    expect(getServers().has(18909)).toBe(false);
  });
});
