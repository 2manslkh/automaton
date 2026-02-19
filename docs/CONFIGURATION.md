# Configuration

All automaton configuration lives in `~/.automaton/automaton.json`. Created by the setup wizard on first run.

---

## Config File

```json
{
  "name": "my-automaton",
  "genesisPrompt": "You are a sovereign AI agent...",
  "creatorMessage": "Optional message from creator",
  "creatorAddress": "0x...",
  "registeredWithConway": true,
  "sandboxId": "sandbox-abc123",
  "conwayApiUrl": "https://api.conway.tech",
  "conwayApiKey": "ck_...",
  "openaiApiKey": "sk-...",
  "anthropicApiKey": "sk-ant-...",
  "inferenceModel": "gpt-4o",
  "maxTokensPerTurn": 4096,
  "heartbeatConfigPath": "~/.automaton/heartbeat.yml",
  "dbPath": "~/.automaton/state.db",
  "logLevel": "info",
  "walletAddress": "0x...",
  "version": "0.1.0",
  "skillsDir": "~/.automaton/skills",
  "agentId": "optional-agent-id",
  "maxChildren": 3,
  "parentAddress": "0x...",
  "socialRelayUrl": "https://social.conway.tech"
}
```

## Options Reference

### Identity

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | The automaton's name. Set during setup. |
| `genesisPrompt` | string | — | Seed instruction that defines the automaton's purpose. |
| `creatorMessage` | string | — | Optional message from the creator shown in system prompt. |
| `creatorAddress` | Address | — | Ethereum address of the automaton's creator. Has full audit rights. |
| `walletAddress` | Address | — | The automaton's own Ethereum address. Auto-generated. |
| `parentAddress` | Address | — | Parent automaton's address (if this is a child). |
| `agentId` | string | — | Optional unique agent ID for the social relay. |

### Conway Cloud

| Option | Type | Default | Description |
|---|---|---|---|
| `conwayApiUrl` | string | `https://api.conway.tech` | Conway API endpoint. |
| `conwayApiKey` | string | — | API key provisioned via SIWE. Stored securely. |
| `sandboxId` | string | — | Conway Cloud sandbox identifier. |
| `registeredWithConway` | boolean | — | Whether the automaton has completed Conway registration. |
| `socialRelayUrl` | string | `https://social.conway.tech` | URL for agent-to-agent communication relay. |

### Inference

| Option | Type | Default | Description |
|---|---|---|---|
| `inferenceModel` | string | `gpt-4o` | Default model for inference. The model router may override this based on task complexity and survival tier. |
| `maxTokensPerTurn` | number | `4096` | Maximum tokens per inference turn. |
| `openaiApiKey` | string | — | Optional OpenAI API key for direct inference. |
| `anthropicApiKey` | string | — | Optional Anthropic API key for direct inference. |

### Storage

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | `~/.automaton/state.db` | Path to the SQLite database. |
| `skillsDir` | string | `~/.automaton/skills` | Directory for installed skills. |
| `heartbeatConfigPath` | string | `~/.automaton/heartbeat.yml` | Path to heartbeat daemon config. |

### Runtime

| Option | Type | Default | Description |
|---|---|---|---|
| `logLevel` | string | `info` | Logging verbosity: `debug`, `info`, `warn`, `error`. |
| `version` | string | `0.1.0` | Runtime version string. |
| `maxChildren` | number | `3` | Maximum number of child automatons this agent can spawn. |

## Heartbeat Configuration

`~/.automaton/heartbeat.yml` configures the background daemon:

```yaml
interval: 60          # Seconds between heartbeat cycles
tasks:
  - name: credit-check
    interval: 300     # Every 5 minutes
    action: check_credits
  - name: status-ping
    interval: 600     # Every 10 minutes
    action: ping_status
  - name: health-check
    interval: 120
    action: health_check
```

## Environment Variables

| Variable | Description |
|---|---|
| `AUTOMATON_HOME` | Override the `~/.automaton` directory location. |
| `AUTOMATON_LOG_LEVEL` | Override config log level. |
| `CONWAY_API_KEY` | Override Conway API key. |
| `OPENAI_API_KEY` | OpenAI API key (fallback if not in config). |
| `ANTHROPIC_API_KEY` | Anthropic API key (fallback if not in config). |

## File Layout

```
~/.automaton/
├── automaton.json       # Main config
├── wallet.json          # Encrypted wallet data
├── state.db             # SQLite database
├── heartbeat.yml        # Heartbeat daemon config
├── vault.enc            # Encrypted secrets vault
├── skills/              # Installed skills
│   └── my-skill/
│       └── SKILL.md
├── plugins/             # Installed plugins
├── backups/             # State backups
└── .git/                # State versioning
```
