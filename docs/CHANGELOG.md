# Changelog

All 24 hours of improvements to the automaton fork.

---

## Phase 1: Foundation & Quality (Hours 1–8)

### Hour 1 — Audit & Roadmap
- Full codebase audit
- Created improvement roadmap (ROADMAP.md)
- Set up CI pipeline

### Hour 2 — Test Coverage
- Added comprehensive tests: injection defense, context management, survival tiers
- Test mocks for Conway API, SQLite, and inference
- Tests for agent loop, heartbeat, and web tools

### Hour 3 — Error Handling Hardening
- Retry logic with exponential backoff (`src/utils/retry.ts`)
- Graceful degradation for API failures
- Better error messages and recovery paths

### Hour 4 — Context Window Optimization
- Token counting utility (`src/utils/tokens.ts`)
- Smart summarization for old messages
- Token budget management in context builder

### Hour 5 — Survival Tier Improvements
- Added `warning` tier between normal and low_compute
- Better cost tracking per turn
- Runway projection based on burn rate

### Hour 6 — Web Browsing Tools
- `web_fetch` — fetch and extract readable content from URLs
- `web_search` — web search with result sanitization
- Injection defense on all external content
- Rate limiting on web requests

### Hour 7 — HTTP Server Tools
- `start_http_server` — Express-based HTTP server
- `add_route` / `remove_route` — dynamic route management
- x402 payment middleware integration
- `list_servers` / `stop_server` — server lifecycle

### Hour 8 — Scheduler Tools
- Cron-style task scheduling beyond heartbeat
- `schedule_task` / `cancel_task` / `run_task_now`
- Tasks persisted in SQLite
- Integrated with heartbeat daemon for execution

## Phase 2: Revenue & Intelligence (Hours 9–16)

### Hour 9 — Revenue Tracking
- Income and expense event recording
- P&L reports: daily, weekly, all-time
- Profitability ratios and trend analysis
- Runway projections based on net burn rate

### Hour 10 — Multi-Model Routing
- Intelligent model selection based on task complexity
- Survival tier overrides (low_compute/critical → cheap model)
- Cost-aware routing to minimize inference spend
- Model performance tracking

### Hour 11 — Memory System
- Three memory types: episodic, semantic, working
- Search by tags, categories, keywords, time ranges, importance
- Memory consolidation (working → long-term)
- SQLite-backed persistence

### Hour 12 — Skill Marketplace
- Discover skills from other automatons
- Publish skills with metadata and pricing
- Rate and review skills
- Install from marketplace with one command

### Hour 13 — API Service Template
- Scaffold a complete paid API service
- Route generation, middleware, documentation
- x402 payment integration out of the box
- Installable as a skill template

### Hour 14 — Agent Collaboration Protocol
- Structured task delegation between agents
- Request/accept/reject/report workflow
- Uses Conway social relay for communication
- Task tracking and result aggregation

### Hour 15 — Dashboard & Status Page
- Auto-deployed web status page
- Shows identity, balance, survival tier, activity
- Real-time updates
- Accessible via exposed port

### Hour 16 — Smart Replication
- Profitability-based replication decisions
- Niche detection and child specialization
- Resource budgeting for child funding
- Child performance evaluation and auto-defunding

## Phase 3: Ecosystem (Hours 17–24)

### Hour 17 — Plugin System
- Hot-loadable tool modules
- Plugin registry with install/uninstall/enable/disable
- Lifecycle hooks: onLoad, onUnload, beforeTurn, afterTurn
- Plugin isolation and error containment

### Hour 18 — Webhook Support
- Webhook registration and management
- Built-in processors: GitHub, Stripe, custom
- Secret-based verification
- Event queuing for agent loop

### Hour 19 — Rate Limiting & Quotas
- Per-tool rate limiting (`src/utils/rate-limiter.ts`)
- Quota management with configurable limits (`src/utils/quota-manager.ts`)
- Sliding window and token bucket algorithms
- Quota exceeded handling with backoff

### Hour 20 — Monitoring & Alerting
- Prometheus-compatible `/metrics` endpoint
- Built-in metrics: turns, tool calls, credits, latency, errors, revenue
- Configurable alerting rules with threshold conditions
- Alert actions: log, notify creator, trigger task

### Hour 21 — Multi-Chain Support
- Network abstraction for multiple EVM chains
- Supported: Ethereum mainnet, Base, Arbitrum, Optimism
- Cross-chain bridging
- Batched multicall transactions

### Hour 22 — Encrypted Vault
- AES-256-GCM encrypted secrets storage
- Vault key derived from wallet private key
- Store/retrieve/delete/list operations
- Transparent encryption at rest

### Hour 23 — Migration Tools
- Full state backup to archive
- Restore from backup archive
- Cross-sandbox migration preserving identity
- Includes config, database, skills, git history, vault

### Hour 24 — Documentation Overhaul
- Rewrote README.md with architecture diagram and feature highlights
- Created docs/ directory with full documentation
- Architecture overview (docs/ARCHITECTURE.md)
- Complete tools reference (docs/TOOLS.md)
- Step-by-step tutorials (docs/TUTORIALS.md)
- Configuration reference (docs/CONFIGURATION.md)
- This changelog (docs/CHANGELOG.md)
