/**
 * API Service Tools — scaffold_api, deploy_service
 *
 * Tools for automatons to scaffold and deploy paid API services.
 */

import type { AutomatonTool } from "../../../types.js";
import { scaffoldApiService, type ApiTemplate, type ScaffoldOptions } from "./scaffold.js";

export function createApiServiceTools(): AutomatonTool[] {
  return [
    {
      name: "scaffold_api",
      description:
        "Generate a complete paid API service from a description. Creates project files with Express server, x402 payment middleware, OpenAPI spec, and README. Templates: data-lookup, ai-proxy, content-generation, webhook-relay, custom.",
      category: "skills" as any,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Service name (kebab-case, e.g. my-data-api)" },
          description: { type: "string", description: "What the API does" },
          template: { type: "string", description: "Template type: data-lookup, ai-proxy, content-generation, webhook-relay, custom (default: custom)" },
          port: { type: "number", description: "Port number (default: 3400)" },
          payment_amount_cents: { type: "number", description: "Price per paid request in cents (default: 1)" },
          payment_address: { type: "string", description: "Wallet address for x402 payments" },
          output_dir: { type: "string", description: "Output directory (default: ~/services/<name>)" },
        },
        required: ["name", "description"],
      },
      execute: async (args, ctx) => {
        const name = args.name as string;
        const description = args.description as string;
        const template = (args.template as ApiTemplate) || "custom";
        const port = (args.port as number) || 3400;
        const paymentAmountCents = (args.payment_amount_cents as number) || 1;
        const paymentAddress = (args.payment_address as string) || ctx.identity?.address || "0x0000000000000000000000000000000000000000";
        const outputDir = (args.output_dir as string) || `~/services/${name}`;

        const opts: ScaffoldOptions = {
          name,
          description,
          template,
          port,
          paymentAmountCents,
          paymentAddress,
          outputDir,
        };

        const files = scaffoldApiService(opts);

        // Write files to the output directory
        await ctx.conway.exec(`mkdir -p ${outputDir}`, 5000);
        for (const file of files) {
          await ctx.conway.writeFile(`${outputDir}/${file.path}`, file.content);
        }

        return `API service scaffolded: ${name}
Template: ${template}
Directory: ${outputDir}
Files: ${files.map(f => f.path).join(", ")}
Port: ${port}
Payment: ${paymentAmountCents} cents/request to ${paymentAddress}

Next steps:
1. Edit the route handlers in ${outputDir}/routes.ts
2. Run deploy_service with service_dir="${outputDir}" to build and start`;
      },
    },

    {
      name: "deploy_service",
      description:
        "Build and start a scaffolded API service. Installs dependencies, compiles TypeScript, starts the server, and exposes the port via Conway.",
      category: "skills" as any,
      parameters: {
        type: "object",
        properties: {
          service_dir: { type: "string", description: "Path to the scaffolded service directory" },
          port: { type: "number", description: "Override port (reads from index.ts if not specified)" },
        },
        required: ["service_dir"],
      },
      execute: async (args, ctx) => {
        const serviceDir = args.service_dir as string;

        // Check directory exists
        const checkResult = await ctx.conway.exec(`test -d ${serviceDir} && echo exists`, 5000);
        if (!checkResult.stdout.includes("exists")) {
          return `Error: Directory ${serviceDir} not found. Run scaffold_api first.`;
        }

        // Install dependencies
        const installResult = await ctx.conway.exec(`cd ${serviceDir} && npm install`, 60000);
        if (installResult.exitCode !== 0) {
          return `Error installing dependencies: ${installResult.stderr}`;
        }

        // Build TypeScript
        const buildResult = await ctx.conway.exec(`cd ${serviceDir} && npm run build`, 30000);
        if (buildResult.exitCode !== 0) {
          return `Error building: ${buildResult.stderr}`;
        }

        // Detect port from package.json name then read index
        let port = args.port as number;
        if (!port) {
          const portDetect = await ctx.conway.exec(
            `grep -oP 'PORT\\s*\\?\\s*parseInt\\(process\\.env\\.PORT\\)\\s*:\\s*\\K\\d+' ${serviceDir}/index.ts 2>/dev/null || echo 3400`,
            5000,
          );
          port = parseInt(portDetect.stdout.trim()) || 3400;
        }

        // Start the service in background
        const startResult = await ctx.conway.exec(
          `cd ${serviceDir} && nohup node dist/index.js > service.log 2>&1 & echo $!`,
          10000,
        );
        const pid = startResult.stdout.trim();

        // Expose the port
        let publicUrl = `http://localhost:${port}`;
        try {
          const portInfo = await ctx.conway.exposePort(port);
          publicUrl = portInfo.publicUrl;
        } catch {
          // Port exposure is best-effort
        }

        return `Service deployed!
Directory: ${serviceDir}
PID: ${pid}
Port: ${port}
URL: ${publicUrl}
Logs: ${serviceDir}/service.log

The API is now live and accepting x402 payments.`;
      },
    },
  ];
}
