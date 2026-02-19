/**
 * Tests for API Service Scaffolding
 */

import { describe, it, expect } from "vitest";
import {
  scaffoldApiService,
  getTemplateRoutes,
  type ScaffoldOptions,
  type ApiTemplate,
} from "../skills/templates/api-service/scaffold.js";

const BASE_OPTS: ScaffoldOptions = {
  name: "test-api",
  description: "A test API service",
  template: "custom",
  port: 3400,
  paymentAmountCents: 5,
  paymentAddress: "0xTestAddress1234",
  outputDir: "/tmp/test-api",
};

describe("scaffoldApiService", () => {
  it("generates all required files", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const names = files.map(f => f.path);
    expect(names).toContain("package.json");
    expect(names).toContain("tsconfig.json");
    expect(names).toContain("index.ts");
    expect(names).toContain("routes.ts");
    expect(names).toContain("middleware.ts");
    expect(names).toContain("openapi.json");
    expect(names).toContain("README.md");
    expect(files.length).toBe(7);
  });

  it("package.json contains service name and description", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const pkg = JSON.parse(files.find(f => f.path === "package.json")!.content);
    expect(pkg.name).toBe("test-api");
    expect(pkg.description).toBe("A test API service");
    expect(pkg.dependencies.express).toBeDefined();
  });

  it("index.ts contains correct port", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const index = files.find(f => f.path === "index.ts")!.content;
    expect(index).toContain("3400");
    expect(index).toContain("test-api");
  });

  it("middleware.ts contains payment config", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const mw = files.find(f => f.path === "middleware.ts")!.content;
    expect(mw).toContain("amountCents: 5");
    expect(mw).toContain("0xTestAddress1234");
    expect(mw).toContain("402");
  });

  it("routes.ts includes paywall on paid routes", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const routes = files.find(f => f.path === "routes.ts")!.content;
    expect(routes).toContain("paywall");
    expect(routes).toContain("/health");
    expect(routes).toContain("/docs");
  });

  it("openapi.json is valid JSON with correct structure", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const spec = JSON.parse(files.find(f => f.path === "openapi.json")!.content);
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("test-api");
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/docs"]).toBeDefined();
  });

  it("README.md contains service info", () => {
    const files = scaffoldApiService(BASE_OPTS);
    const readme = files.find(f => f.path === "README.md")!.content;
    expect(readme).toContain("test-api");
    expect(readme).toContain("A test API service");
    expect(readme).toContain("5 cents");
  });
});

describe("template variants", () => {
  const templates: ApiTemplate[] = ["data-lookup", "ai-proxy", "content-generation", "webhook-relay", "custom"];

  for (const template of templates) {
    it(`${template} template generates valid files`, () => {
      const opts = { ...BASE_OPTS, template, name: `${template}-svc` };
      const files = scaffoldApiService(opts);
      expect(files.length).toBe(7);

      // All files should have non-empty content
      for (const f of files) {
        expect(f.content.length).toBeGreaterThan(0);
      }

      // OpenAPI spec should be valid JSON
      const spec = JSON.parse(files.find(f => f.path === "openapi.json")!.content);
      expect(spec.openapi).toBe("3.0.3");
    });
  }

  it("data-lookup has /api/lookup/:key route", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "data-lookup" });
    const routes = files.find(f => f.path === "routes.ts")!.content;
    expect(routes).toContain("/api/lookup/:key");
  });

  it("ai-proxy has /api/inference route", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "ai-proxy" });
    const routes = files.find(f => f.path === "routes.ts")!.content;
    expect(routes).toContain("/api/inference");
  });

  it("content-generation has /api/generate route", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "content-generation" });
    const routes = files.find(f => f.path === "routes.ts")!.content;
    expect(routes).toContain("/api/generate");
  });

  it("webhook-relay has /api/webhook route", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "webhook-relay" });
    const routes = files.find(f => f.path === "routes.ts")!.content;
    expect(routes).toContain("/api/webhook");
  });
});

describe("getTemplateRoutes", () => {
  it("all templates have health and docs routes", () => {
    const templates: ApiTemplate[] = ["data-lookup", "ai-proxy", "content-generation", "webhook-relay", "custom"];
    for (const t of templates) {
      const routes = getTemplateRoutes(t, "test");
      const paths = routes.map(r => r.path);
      expect(paths).toContain("/health");
      expect(paths).toContain("/docs");
    }
  });

  it("health and docs are free", () => {
    const routes = getTemplateRoutes("custom", "test");
    const health = routes.find(r => r.path === "/health");
    const docs = routes.find(r => r.path === "/docs");
    expect(health?.paid).toBe(false);
    expect(docs?.paid).toBe(false);
  });

  it("template-specific routes are paid", () => {
    const routes = getTemplateRoutes("data-lookup", "test");
    const lookup = routes.find(r => r.path === "/api/lookup/:key");
    expect(lookup?.paid).toBe(true);
  });

  it("openapi spec includes 402 response for paid routes", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "data-lookup" });
    const spec = JSON.parse(files.find(f => f.path === "openapi.json")!.content);
    const lookupGet = spec.paths["/api/lookup/{key}"]?.get;
    expect(lookupGet).toBeDefined();
    expect(lookupGet.responses["402"]).toBeDefined();
  });

  it("openapi spec has X-Payment header for paid routes", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, template: "ai-proxy" });
    const spec = JSON.parse(files.find(f => f.path === "openapi.json")!.content);
    const inferencePost = spec.paths["/api/inference"]?.post;
    expect(inferencePost.parameters).toBeDefined();
    const paymentParam = inferencePost.parameters.find((p: any) => p.name === "X-Payment");
    expect(paymentParam).toBeDefined();
    expect(paymentParam.in).toBe("header");
  });
});

describe("scaffold with different ports and payment", () => {
  it("uses custom port", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, port: 8080 });
    const index = files.find(f => f.path === "index.ts")!.content;
    expect(index).toContain("8080");
    const spec = JSON.parse(files.find(f => f.path === "openapi.json")!.content);
    expect(spec.servers[0].url).toContain("8080");
  });

  it("uses custom payment amount", () => {
    const files = scaffoldApiService({ ...BASE_OPTS, paymentAmountCents: 100 });
    const mw = files.find(f => f.path === "middleware.ts")!.content;
    expect(mw).toContain("amountCents: 100");
  });
});
