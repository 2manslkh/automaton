# Automaton Fork — Improvement Roadmap

*Last updated: 2026-02-19*

## Phase 1: Foundation & Quality (Hours 1-8)
- [x] **Hour 1**: Audit codebase, create roadmap, set up CI
- [ ] **Hour 2**: Add comprehensive test coverage (injection-defense, context, survival)
- [ ] **Hour 3**: Error handling hardening — retry logic, graceful degradation
- [ ] **Hour 4**: Context window optimization — smarter summarization, token counting
- [ ] **Hour 5**: Improve survival tiers — add `warning` tier, better cost tracking
- [ ] **Hour 6**: Add web browsing tool (fetch URLs, scrape pages)
- [ ] **Hour 7**: Add HTTP server tool (serve endpoints to earn money)
- [ ] **Hour 8**: Add cron/scheduler tool (beyond heartbeat)

## Phase 2: Revenue & Intelligence (Hours 9-16)
- [ ] **Hour 9**: Revenue tracking system — track earnings, expenses, P&L
- [ ] **Hour 10**: Multi-model routing — use cheap models for simple tasks
- [ ] **Hour 11**: Memory system — long-term memory beyond SQLite KV
- [ ] **Hour 12**: Skill marketplace — discover/install skills from other automatons
- [ ] **Hour 13**: API service template — scaffold a paid API service
- [ ] **Hour 14**: Agent collaboration protocol — structured agent-to-agent tasks
- [ ] **Hour 15**: Dashboard/status page — auto-deploy a web status page
- [ ] **Hour 16**: Improved replication — smarter child specialization

## Phase 3: Ecosystem (Hours 17-24)
- [ ] **Hour 17**: Plugin system — loadable tool modules
- [ ] **Hour 18**: Webhook support — receive external events
- [ ] **Hour 19**: Rate limiting & quota management
- [ ] **Hour 20**: Monitoring & alerting — Prometheus-compatible metrics
- [ ] **Hour 21**: Multi-chain support — Ethereum mainnet, Arbitrum, etc.
- [ ] **Hour 22**: Encrypted state — protect sensitive data at rest
- [ ] **Hour 23**: Migration tools — backup/restore/migrate between sandboxes
- [ ] **Hour 24**: Documentation overhaul — API docs, tutorials, examples

## Completed Improvements
*(tracked per commit)*

## Design Principles
1. **Backward compatible** — don't break existing automatons
2. **Test everything** — every new feature gets tests
3. **Small commits** — one improvement per commit, well-documented
4. **Security first** — new tools get injection defense review
