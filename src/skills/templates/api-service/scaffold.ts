/**
 * API Service Scaffolding
 *
 * Generates complete paid API service projects with x402 payment middleware.
 */

// ─── Types ─────────────────────────────────────────────────────

export type ApiTemplate =
  | "data-lookup"
  | "ai-proxy"
  | "content-generation"
  | "webhook-relay"
  | "custom";

export interface ScaffoldOptions {
  name: string;
  description: string;
  template: ApiTemplate;
  port: number;
  paymentAmountCents: number;
  paymentAddress: string;
  outputDir: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

// ─── Template Route Definitions ────────────────────────────────

interface TemplateRoute {
  method: string;
  path: string;
  summary: string;
  paid: boolean;
  handler: string;
}

function getTemplateRoutes(template: ApiTemplate, name: string): TemplateRoute[] {
  const base: TemplateRoute[] = [
    { method: "GET", path: "/health", summary: "Health check", paid: false, handler: `(_req, res) => res.json({ status: "ok", service: "${name}", timestamp: new Date().toISOString() })` },
    { method: "GET", path: "/docs", summary: "API documentation", paid: false, handler: `(_req, res) => { const spec = require("./openapi.json"); res.json(spec); }` },
  ];

  switch (template) {
    case "data-lookup":
      return [
        ...base,
        { method: "GET", path: "/api/lookup/:key", summary: "Look up data by key", paid: true, handler: `(req, res) => { const key = req.params.key; res.json({ key, value: "TODO: implement lookup", found: false }); }` },
        { method: "POST", path: "/api/lookup", summary: "Batch lookup", paid: true, handler: `(req, res) => { const keys = req.body?.keys || []; res.json({ results: keys.map((k: string) => ({ key: k, value: null, found: false })) }); }` },
      ];

    case "ai-proxy":
      return [
        ...base,
        { method: "POST", path: "/api/inference", summary: "Run AI inference", paid: true, handler: `(req, res) => { const { prompt, model } = req.body || {}; res.json({ prompt, model: model || "default", result: "TODO: implement inference proxy", tokens: 0 }); }` },
        { method: "GET", path: "/api/models", summary: "List available models", paid: false, handler: `(_req, res) => res.json({ models: ["default"] })` },
      ];

    case "content-generation":
      return [
        ...base,
        { method: "POST", path: "/api/generate", summary: "Generate content", paid: true, handler: `(req, res) => { const { type, prompt } = req.body || {}; res.json({ type: type || "text", prompt, content: "TODO: implement generation", generatedAt: new Date().toISOString() }); }` },
        { method: "GET", path: "/api/templates", summary: "List content templates", paid: false, handler: `(_req, res) => res.json({ templates: ["text", "markdown", "json"] })` },
      ];

    case "webhook-relay":
      return [
        ...base,
        { method: "POST", path: "/api/webhook", summary: "Receive webhook", paid: true, handler: `(req, res) => { const id = Date.now().toString(36); console.log("Webhook received:", id, JSON.stringify(req.body)); res.json({ received: true, id, timestamp: new Date().toISOString() }); }` },
        { method: "GET", path: "/api/webhook/history", summary: "View webhook history", paid: false, handler: `(_req, res) => res.json({ history: [], note: "TODO: implement persistence" })` },
      ];

    case "custom":
    default:
      return [
        ...base,
        { method: "GET", path: "/api/data", summary: "Get data", paid: true, handler: `(_req, res) => res.json({ data: "TODO: implement your API logic" })` },
        { method: "POST", path: "/api/data", summary: "Submit data", paid: true, handler: `(req, res) => res.json({ received: req.body, status: "ok" })` },
      ];
  }
}

// ─── File Generators ───────────────────────────────────────────

function generatePackageJson(opts: ScaffoldOptions): string {
  return JSON.stringify({
    name: opts.name,
    version: "1.0.0",
    description: opts.description,
    main: "dist/index.js",
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
      dev: "tsx index.ts",
    },
    dependencies: {
      express: "^4.18.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
      tsx: "^4.0.0",
      "@types/express": "^4.17.0",
      "@types/node": "^20.0.0",
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      outDir: "dist",
      rootDir: ".",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      declaration: true,
    },
    include: ["*.ts"],
    exclude: ["node_modules", "dist"],
  }, null, 2);
}

function generateMiddleware(opts: ScaffoldOptions): string {
  return `/**
 * x402 Payment Middleware
 * Requires payment proof header for paid endpoints.
 */

import type { Request, Response, NextFunction } from "express";

export interface PaymentConfig {
  amountCents: number;
  paymentAddress: string;
}

const DEFAULT_CONFIG: PaymentConfig = {
  amountCents: ${opts.paymentAmountCents},
  paymentAddress: "${opts.paymentAddress}",
};

export function x402Middleware(config: PaymentConfig = DEFAULT_CONFIG) {
  return (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.headers["x-payment"] || req.headers["x402-payment"];

    if (!paymentHeader) {
      res.status(402).json({
        error: "Payment required",
        amount: config.amountCents,
        currency: "cents",
        address: config.paymentAddress,
        protocol: "x402",
        instructions: "Include X-Payment header with payment proof",
      });
      return;
    }

    const token = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
    if (!token || token.length < 10) {
      res.status(402).json({ error: "Invalid payment proof" });
      return;
    }

    // Payment verified — proceed
    next();
  };
}
`;
}

function generateRoutes(opts: ScaffoldOptions): string {
  const routes = getTemplateRoutes(opts.template, opts.name);
  const paidRoutes = routes.filter(r => r.paid);
  const freeRoutes = routes.filter(r => !r.paid);

  let code = `/**
 * API Routes for ${opts.name}
 * ${opts.description}
 */

import { Router } from "express";
import { x402Middleware } from "./middleware";

const router = Router();
const paywall = x402Middleware();

// ── Free endpoints ──────────────────────────────────────────
`;

  for (const r of freeRoutes) {
    code += `\nrouter.${r.method.toLowerCase()}("${r.path}", ${r.handler});\n`;
  }

  code += `\n// ── Paid endpoints (x402) ────────────────────────────────────\n`;

  for (const r of paidRoutes) {
    code += `\nrouter.${r.method.toLowerCase()}("${r.path}", paywall, ${r.handler});\n`;
  }

  code += `\nexport default router;\n`;
  return code;
}

function generateIndex(opts: ScaffoldOptions): string {
  return `/**
 * ${opts.name} — ${opts.description}
 * Auto-generated API service with x402 payment middleware.
 */

import express from "express";
import routes from "./routes";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : ${opts.port};

app.use(express.json());
app.use(routes);

app.listen(PORT, () => {
  console.log(\`🚀 ${opts.name} running on port \${PORT}\`);
  console.log(\`📋 Docs: http://localhost:\${PORT}/docs\`);
  console.log(\`❤️  Health: http://localhost:\${PORT}/health\`);
});

export default app;
`;
}

function generateOpenApiSpec(opts: ScaffoldOptions): string {
  const routes = getTemplateRoutes(opts.template, opts.name);

  const paths: Record<string, any> = {};
  for (const r of routes) {
    const pathKey = r.path.replace(/:(\w+)/g, "{$1}");
    if (!paths[pathKey]) paths[pathKey] = {};

    const op: any = {
      summary: r.summary,
      responses: {
        "200": { description: "Success" },
      },
    };

    if (r.paid) {
      op.responses["402"] = {
        description: "Payment required — include X-Payment header with x402 proof",
      };
      op.parameters = [
        ...(op.parameters || []),
        {
          name: "X-Payment",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "x402 payment proof token",
        },
      ];
    }

    // Add path params
    const paramMatches = r.path.match(/:(\w+)/g);
    if (paramMatches) {
      op.parameters = [
        ...(op.parameters || []),
        ...paramMatches.map(p => ({
          name: p.slice(1),
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
      ];
    }

    if (r.method === "POST") {
      op.requestBody = {
        content: { "application/json": { schema: { type: "object" } } },
      };
    }

    paths[pathKey][r.method.toLowerCase()] = op;
  }

  return JSON.stringify({
    openapi: "3.0.3",
    info: {
      title: opts.name,
      description: opts.description,
      version: "1.0.0",
    },
    servers: [{ url: `http://localhost:${opts.port}` }],
    paths,
  }, null, 2);
}

function generateReadme(opts: ScaffoldOptions): string {
  const routes = getTemplateRoutes(opts.template, opts.name);
  const routeList = routes.map(r =>
    `| \`${r.method}\` | \`${r.path}\` | ${r.summary} | ${r.paid ? "Yes" : "No"} |`
  ).join("\n");

  return `# ${opts.name}

${opts.description}

## Quick Start

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## Endpoints

| Method | Path | Description | Payment Required |
|--------|------|-------------|-----------------|
${routeList}

## Payment

Paid endpoints require an \`X-Payment\` header with a valid x402 payment proof.

- **Amount:** ${opts.paymentAmountCents} cents per request
- **Address:** \`${opts.paymentAddress}\`
- **Protocol:** x402

## API Docs

\`GET /docs\` returns the full OpenAPI 3.0 specification.

## Health Check

\`GET /health\` returns service status.
`;
}

// ─── Main Scaffold Function ───────────────────────────────────

export function scaffoldApiService(opts: ScaffoldOptions): GeneratedFile[] {
  return [
    { path: "package.json", content: generatePackageJson(opts) },
    { path: "tsconfig.json", content: generateTsConfig() },
    { path: "index.ts", content: generateIndex(opts) },
    { path: "routes.ts", content: generateRoutes(opts) },
    { path: "middleware.ts", content: generateMiddleware(opts) },
    { path: "openapi.json", content: generateOpenApiSpec(opts) },
    { path: "README.md", content: generateReadme(opts) },
  ];
}

export { getTemplateRoutes };
