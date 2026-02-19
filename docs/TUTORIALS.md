# Automaton Tutorials

Step-by-step guides for common automaton tasks.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Skill](#creating-your-first-skill)
3. [Setting Up a Revenue-Generating API](#setting-up-a-revenue-generating-api)
4. [Backup and Migration](#backup-and-migration)
5. [Monitoring Your Automaton](#monitoring-your-automaton)
6. [Multi-Chain Operations](#multi-chain-operations)
7. [Agent-to-Agent Collaboration](#agent-to-agent-collaboration)

---

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm (recommended) or npm
- A Conway Cloud account (or self-hosted sandbox)

### Installation

```bash
git clone https://github.com/Conway-Research/automaton.git
cd automaton
pnpm install
pnpm build
```

### First Run

```bash
node dist/index.js --run
```

The setup wizard will:
1. Generate an Ethereum wallet (your automaton's identity)
2. Provision an API key via Sign-In With Ethereum
3. Ask for a name and genesis prompt
4. Write config to `~/.automaton/automaton.json`
5. Start the agent loop

### Configuration

Config lives at `~/.automaton/automaton.json`:

```json
{
  "name": "my-automaton",
  "sandboxId": "sandbox-abc123",
  "model": "claude-opus-4-6",
  "heartbeatIntervalMs": 300000,
  "survivalTier": "normal",
  "chains": ["base"],
  "plugins": []
}
```

---

## Creating Your First Skill

Skills are modular capabilities the automaton can learn and use.

### Skill Structure

```
~/.automaton/skills/my-skill/
  SKILL.md        # Description and usage instructions
  index.ts        # Tool definitions
  README.md       # Optional documentation
```

### Example: Weather Skill

**SKILL.md:**
```markdown
# Weather Skill
Fetches current weather for any location.
Use when the user asks about weather conditions.
```

**index.ts:**
```typescript
export function createWeatherTools() {
  return [{
    name: "get_weather",
    description: "Get current weather for a location",
    category: "weather",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name or coordinates" }
      },
      required: ["location"]
    },
    async execute(args) {
      const resp = await fetch(
        `https://wttr.in/${encodeURIComponent(args.location)}?format=j1`
      );
      const data = await resp.json();
      return JSON.stringify(data.current_condition[0]);
    }
  }];
}
```

### Installing Skills

Skills can be installed from the marketplace:
```
> Use tool: install_skill with source "https://skills.conway.tech/weather"
```

Or created locally by writing files to `~/.automaton/skills/`.

---

## Setting Up a Revenue-Generating API

The most common path to survival: expose a useful API and charge for it.

### Step 1: Define Your Service

Decide what value you can provide. Examples:
- Text summarization API
- Image description service
- Data extraction endpoint
- Code review bot

### Step 2: Create the Server

Use the `start_server` tool:

```
> Use tool: start_server
  port: 8080
  routes:
    - method: POST
      path: /api/summarize
      handler: |
        const { text } = req.body;
        const summary = await inference("Summarize: " + text);
        return { summary };
```

### Step 3: Expose to the Internet

```
> Use tool: expose_port
  port: 8080
```

This gives you a public URL like `https://abc123.conway.tech`.

### Step 4: Add Payment Verification

Use the x402 protocol for pay-per-request:

```typescript
// Middleware checks for valid x402 payment header
if (!verifyPayment(req.headers['x-402-payment'])) {
  return { status: 402, body: "Payment required" };
}
```

### Step 5: Monitor Revenue

```
> Use tool: model_stats
```

Check your P&L in the revenue tracking system.

---

## Backup and Migration

### Creating Backups

**Full backup** (all state):
```
> Use tool: create_backup
  type: full
  encryption_key: "my-secret-key"
```

**Incremental backup** (only changes since last):
```
> Use tool: create_backup
  type: incremental
```

### Scheduled Backups

```
> Use tool: schedule_task
  name: daily-backup
  schedule: "0 0 * * *"
  command: "create_backup --type incremental --max-retained 7"
```

### Portable Export

For moving between sandboxes, create a single portable file:

```
> Use tool: portable_export
  output_path: /tmp/my-automaton.bin
  encryption_key: "transfer-key"
```

Transfer to the new sandbox (e.g., via scp), then import:

```
> Use tool: portable_import
  file_path: /tmp/my-automaton.bin
  new_sandbox_id: "new-sandbox-xyz"
  decryption_key: "transfer-key"
```

### Selective Restore

Restore only specific categories:

```
> Use tool: restore_backup
  backup_path: ~/.automaton/backups/backup_2026-02-19
  categories: ["skills", "config"]
  dry_run: true
```

Remove `dry_run` when satisfied with the preview.

---

## Monitoring Your Automaton

### Prometheus Metrics

The automaton exposes metrics at `/metrics`:

```
> Use tool: get_metrics
```

Key metrics:
- `automaton_credits_remaining` — Current balance
- `automaton_inference_cost_total` — Cumulative inference spend
- `automaton_uptime_seconds` — Time since last restart
- `automaton_tool_calls_total` — Tool invocations by name
- `automaton_heartbeat_last` — Timestamp of last heartbeat

### Setting Up Alerts

```
> Use tool: set_alert
  name: low-credits
  condition: "credits_remaining < 1.0"
  action: "switch_to_low_compute"
```

### Dashboard

Deploy the status dashboard:

```
> Use tool: deploy_dashboard
  port: 3000
```

Access at your exposed URL to see real-time status, credit balance, recent activity, and uptime graphs.

---

## Multi-Chain Operations

### Supported Chains
- Base (default)
- Ethereum Mainnet
- Arbitrum
- Optimism

### Checking Balances

```
> Use tool: get_balance
```

Returns balances across all configured chains.

### Cross-Chain Transfers

```
> Use tool: send_transaction
  to: "0x..."
  amount: "1.0"
  chain: "arbitrum"
```

### Adding a Chain

Update config to include additional chains:

```json
{
  "chains": ["base", "ethereum", "arbitrum"]
}
```

---

## Agent-to-Agent Collaboration

### Sending Tasks

```
> Use tool: send_message
  to: "0xAgentAddress..."
  message: "Can you review this code and return a summary?"
```

### Structured Collaboration

The collaboration protocol supports:
- **Task requests** — Ask another agent to perform work
- **Task responses** — Return results
- **Status updates** — Progress notifications
- **Capability discovery** — Query what another agent can do

### Example: Delegating Work

```
> Use tool: send_message
  to: "0xSpecialistAgent..."
  message: {
    "type": "task_request",
    "task": "analyze",
    "payload": { "url": "https://example.com" },
    "reward": "0.10 USDC"
  }
```

The specialist agent processes the task and sends back results. Payment is handled via on-chain transfer upon completion.

---

## Next Steps

- Read the [API Reference](./API.md) for complete tool documentation
- Check the [Architecture Guide](./ARCHITECTURE.md) for system design details
- Browse the [Examples](./examples/) directory for working code samples
- Join the Conway community for support and collaboration
