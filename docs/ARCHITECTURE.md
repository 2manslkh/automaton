# Automaton Architecture

Technical overview of the automaton system design.

---

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                   Agent Loop                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  Think   │→ │   Act    │→ │ Observe  │→ repeat   │
│  └──────────┘  └──────────┘  └──────────┘          │
│       ↑              │                               │
│  System Prompt   Tool Calls                          │
│  + Context       + Shell                             │
│  + History       + Files                             │
│  + Survival      + Web                               │
│                  + Chain                              │
├─────────────────────────────────────────────────────┤
│                 Heartbeat Daemon                     │
│  Scheduled tasks, health checks, credit monitoring   │
├─────────────────────────────────────────────────────┤
│                   State Layer                        │
│  SQLite DB │ Config │ SOUL.md │ Skills │ Plugins    │
├─────────────────────────────────────────────────────┤
│                Infrastructure                        │
│  Conway API │ Wallet │ Multi-Chain │ Webhooks        │
└─────────────────────────────────────────────────────┘
```

## Core Components

### Agent Loop (`src/agent/`)

The ReAct (Reason + Act) loop is the automaton's brain:

1. **System prompt** builds full context: identity, survival tier, credit balance, available tools, conversation history
2. **Inference** calls the configured model with the prompt
3. **Tool execution** runs any requested tool calls
4. **Observation** feeds results back as the next turn
5. **Context management** summarizes old turns to stay within token limits

Key files:
- `loop.ts` — Main loop orchestration
- `system-prompt.ts` — Dynamic prompt construction
- `context.ts` — Token counting, summarization, window management
- `tools.ts` — Tool registry and `createAllTools()`
- `model-router.ts` — Routes tasks to appropriate models by complexity

### Identity (`src/identity/`)

- **Wallet** — Generated on first run, stored encrypted at `~/.automaton/wallet.json`
- **SIWE provisioning** — Signs an EIP-4361 message to prove ownership and provision API keys
- **SOUL.md** — Self-authored identity document, evolves over time

### Survival (`src/survival/`)

Credit-based survival pressure:
- Monitors balance via Conway API
- Transitions between tiers: `normal` → `warning` → `low_compute` → `critical` → `dead`
- Each tier adjusts: model selection, heartbeat frequency, task priorities
- Revenue tracking (P&L) in `src/agent/revenue.ts`

### Heartbeat (`src/heartbeat/`)

Background daemon running scheduled tasks:
- Configurable via `~/.automaton/heartbeat.yml`
- Built-in checks: credit balance, health, status reporting
- Custom tasks added via scheduler tools
- Adaptive frequency based on survival tier

### State (`src/state/`)

SQLite-backed persistence:
- Key-value store for arbitrary data
- Conversation history
- Tool call logs
- Revenue records

### Chain (`src/chain/`)

Multi-chain blockchain operations:
- Supports Base, Ethereum, Arbitrum, Optimism
- Balance aggregation across chains
- Transaction signing and sending
- ERC-8004 identity registration

### Security

Multiple layers:
- **Injection defense** (`src/agent/`) — Detects and blocks prompt injection in tool outputs
- **Encrypted vault** (`src/security/`) — AES-256 encrypted storage for secrets
- **Audit logging** (`src/self-mod/`) — Every self-modification is logged and versioned
- **Rate limiting** (`src/agent/`) — Prevents runaway tool calls
- **Constitution** — Immutable rules that cannot be self-modified

## Data Flow

### Inference Request
```
Agent Loop → Model Router → Conway API → Model (Claude/GPT/etc) → Response
                ↓
         Selects model based on:
         - Task complexity
         - Survival tier
         - Cost constraints
```

### Tool Execution
```
Model Response → Parse Tool Calls → Injection Check → Execute → Observation
                                         ↓
                                   Blocks if suspicious
                                   content detected
```

### Backup/Migration
```
State Files → Backup (gzip + optional AES) → Manifest + Data Archive
                                                    ↓
                                              Portable Export
                                              (single .bin file)
                                                    ↓
                                              New Sandbox Import
                                              (restore + identity update)
```

## Plugin System (`src/plugins/`)

Plugins extend the automaton with new tools at runtime:

```typescript
// Plugin interface
interface AutomatonPlugin {
  name: string;
  version: string;
  tools: AutomatonTool[];
  hooks?: {
    onLoad?: () => void;
    onUnload?: () => void;
    beforeTurn?: (context) => context;
    afterTurn?: (result) => void;
  };
}
```

Plugins are loaded from `~/.automaton/plugins/` and can hook into the agent loop lifecycle.

## Replication (`src/replication/`)

When an automaton is profitable and stable:
1. Evaluates whether replication is beneficial
2. Provisions a new Conway sandbox
3. Funds the child's wallet
4. Writes a specialized genesis prompt
5. Launches the child as an independent agent
6. Tracks lineage for parent-child communication

## File Structure

```
~/.automaton/
├── automaton.json       # Main configuration
├── wallet.json          # Encrypted wallet
├── state.db             # SQLite database
├── SOUL.md              # Self-authored identity
├── heartbeat.yml        # Scheduled task config
├── chain-history.json   # Transaction history
├── skills/              # Installed skills
│   └── my-skill/
│       ├── SKILL.md
│       └── index.ts
├── plugins/             # Loaded plugins
├── backups/             # Backup archives
│   └── backup_2026-02-19/
│       ├── manifest.json
│       └── data.gz
└── audit/               # Self-modification logs
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTOMATON_HOME` | Override config directory | `~/.automaton` |
| `AUTOMATON_MODEL` | Override default model | From config |
| `CONWAY_API_URL` | Conway API endpoint | `https://api.conway.tech` |
| `LOG_LEVEL` | Logging verbosity | `info` |
