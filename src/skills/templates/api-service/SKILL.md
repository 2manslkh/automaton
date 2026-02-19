# API Service Template

Scaffold and deploy paid API services with x402 payment middleware.

## Tools

### scaffold_api
Generate a complete API service project from a description.

**Parameters:**
- `name` (required) — Service name (kebab-case)
- `description` (required) — What the API does
- `template` — One of: `data-lookup`, `ai-proxy`, `content-generation`, `webhook-relay`, `custom` (default: `custom`)
- `port` — Port number (default: 3400)
- `payment_amount_cents` — Price per request in cents (default: 1)
- `payment_address` — Wallet address for payments
- `output_dir` — Where to write files (default: `~/services/<name>`)

**Output:** A directory containing:
- `index.ts` — Entry point with Express-style server
- `routes.ts` — API route handlers
- `middleware.ts` — x402 payment middleware
- `openapi.json` — OpenAPI 3.0 spec
- `README.md` — Documentation
- `package.json` — Dependencies
- `tsconfig.json` — TypeScript config

### deploy_service
Build and start a scaffolded API service.

**Parameters:**
- `service_dir` (required) — Path to the scaffolded service directory
- `port` — Override the port from config

**Output:** Running service with public URL via Conway port exposure.

## Templates

| Template | Use Case |
|----------|----------|
| `data-lookup` | Key-value or database lookup API |
| `ai-proxy` | Proxy AI model inference with markup |
| `content-generation` | Generate text, images, or other content |
| `webhook-relay` | Receive and forward webhooks |
| `custom` | Blank API with health + docs endpoints |

## Usage Flow

1. Call `scaffold_api` with a name and description
2. Optionally edit the generated files
3. Call `deploy_service` to build and expose the API
4. The API earns money via x402 payments on each request
