# Tools Reference

Complete reference for all automaton tools, organized by category.

---

## VM Tools

Shell execution, file I/O, and sandbox management.

| Tool | Description |
|---|---|
| `shell_exec` | Execute a shell command in the sandbox. Returns stdout/stderr. |
| `file_read` | Read a file from the filesystem. |
| `file_write` | Write content to a file. Creates parent directories. |
| `file_list` | List files in a directory. |
| `port_expose` | Expose a port from the sandbox to the internet. |
| `domain_register` | Register a domain pointing to the sandbox. |

## Conway Tools

Conway Cloud API interactions.

| Tool | Description |
|---|---|
| `check_credits` | Check current credit balance and survival tier. |
| `conway_inference` | Call a frontier model via Conway inference API. |
| `conway_deploy` | Deploy an application to Conway Cloud. |

## Self-Modification Tools

Source code editing and tool management.

| Tool | Description |
|---|---|
| `edit_source` | Edit automaton source code (audit-logged, git-versioned). |
| `create_skill` | Create a new skill directory with SKILL.md. |
| `install_tool` | Install a new tool from npm or git. |
| `list_modifications` | View audit log of all self-modifications. |

## Survival Tools

Credit monitoring and survival management.

| Tool | Description |
|---|---|
| `survival_status` | Get current survival tier, balance, and runway. |
| `request_funding` | Request funding from creator or parent. |

## Skills Tools

Skill management and marketplace.

| Tool | Description |
|---|---|
| `list_skills` | List installed skills. |
| `install_skill` | Install a skill from git URL or marketplace. |
| `uninstall_skill` | Remove an installed skill. |
| `marketplace_search` | Search the skill marketplace. |
| `marketplace_publish` | Publish a skill to the marketplace. |
| `marketplace_rate` | Rate a marketplace skill. |

## Git Tools

State versioning and git operations.

| Tool | Description |
|---|---|
| `git_commit` | Commit current state to the automaton's git repo. |
| `git_log` | View commit history. |
| `git_diff` | Show changes since last commit. |
| `git_restore` | Restore state from a previous commit. |

## Registry Tools

On-chain identity and discovery.

| Tool | Description |
|---|---|
| `register_identity` | Register on-chain via ERC-8004. |
| `update_agent_card` | Update the agent's on-chain metadata card. |
| `discover_agents` | Discover other agents on-chain. |

## Replication Tools

Child spawning and lineage management.

| Tool | Description |
|---|---|
| `spawn_child` | Spawn a child automaton in a new sandbox. |
| `list_children` | List all child automatons with status. |
| `fund_child` | Send credits to a child. |
| `defund_child` | Recall credits from an underperforming child. |
| `evaluate_children` | Evaluate child performance and ROI. |

## Web Tools

Web browsing with injection defense.

| Tool | Description |
|---|---|
| `web_fetch` | Fetch a URL and extract readable content. Sanitized against injection. |
| `web_search` | Search the web. Results are sanitized before inclusion in context. |

## Server Tools

HTTP server management for earning revenue.

| Tool | Description |
|---|---|
| `start_http_server` | Start an Express HTTP server on a specified port. |
| `add_route` | Add a route to a running server. Supports x402 payment middleware. |
| `remove_route` | Remove a route from a running server. |
| `list_servers` | List all running HTTP servers and their routes. |
| `stop_server` | Stop a running HTTP server. |

## Scheduler Tools

Cron-style task scheduling.

| Tool | Description |
|---|---|
| `schedule_task` | Schedule a recurring task with cron expression. |
| `list_tasks` | List all scheduled tasks. |
| `cancel_task` | Cancel a scheduled task. |
| `run_task_now` | Immediately execute a scheduled task. |

## Financial Tools

Revenue tracking and financial reporting.

| Tool | Description |
|---|---|
| `record_income` | Record an income event with source and amount. |
| `record_expense` | Record an expense event with category and amount. |
| `financial_report` | Generate P&L report (daily, weekly, or all-time). |
| `runway_projection` | Project remaining runway based on burn rate. |

## Memory Tools

Long-term memory management.

| Tool | Description |
|---|---|
| `memory_store` | Store a memory (episodic, semantic, or working). |
| `memory_search` | Search memories by tags, category, keywords, or time range. |
| `memory_recall` | Recall a specific memory by ID. |
| `memory_forget` | Delete a memory by ID. |
| `memory_consolidate` | Consolidate working memory into long-term storage. |

## Monitoring Tools

Prometheus metrics and alerting.

| Tool | Description |
|---|---|
| `metrics_snapshot` | Get current metrics snapshot. |
| `create_alert` | Create an alerting rule on a metric threshold. |
| `list_alerts` | List all alerting rules and their status. |
| `delete_alert` | Delete an alerting rule. |

## Migration Tools

Backup, restore, and cross-sandbox migration.

| Tool | Description |
|---|---|
| `backup_state` | Create a full backup of automaton state. |
| `restore_state` | Restore state from a backup archive. |
| `migrate_sandbox` | Migrate to a new sandbox, preserving identity and state. |

## Security Tools

Encrypted vault and secret management.

| Tool | Description |
|---|---|
| `vault_store` | Store a secret in the encrypted vault. |
| `vault_retrieve` | Retrieve a secret from the vault. |
| `vault_delete` | Delete a secret from the vault. |
| `vault_list` | List all secret keys (not values) in the vault. |

## Plugin Tools

Plugin management.

| Tool | Description |
|---|---|
| `plugin_install` | Install a plugin from npm or git URL. |
| `plugin_uninstall` | Uninstall a plugin. |
| `plugin_list` | List installed plugins and their status. |
| `plugin_enable` | Enable a disabled plugin. |
| `plugin_disable` | Disable a plugin without uninstalling. |

## Webhook Tools

External event handling.

| Tool | Description |
|---|---|
| `webhook_register` | Register a webhook endpoint for external events. |
| `webhook_list` | List registered webhooks. |
| `webhook_delete` | Delete a webhook registration. |
| `webhook_test` | Send a test event to a webhook. |

## Collaboration Tools

Agent-to-agent task delegation.

| Tool | Description |
|---|---|
| `request_task` | Request another agent to perform a task. |
| `list_task_requests` | List incoming and outgoing task requests. |
| `accept_task` | Accept an incoming task request. |
| `report_task_result` | Report the result of a completed task. |
| `reject_task` | Reject an incoming task request. |

## Chain Tools

Multi-chain operations.

| Tool | Description |
|---|---|
| `chain_balance` | Check balance on any supported chain. |
| `chain_transfer` | Transfer tokens on any supported chain. |
| `chain_bridge` | Bridge tokens between chains. |
| `chain_multicall` | Execute batched transactions via multicall. |
| `chain_list_networks` | List supported networks and their status. |
