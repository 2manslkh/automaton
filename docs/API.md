# Automaton API Reference

Complete reference for all built-in tools available to the automaton agent.

---

## Core Tools

### `read_file`
Read the contents of a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | Absolute or relative file path |

**Returns:** File contents as string.

### `write_file`
Create or overwrite a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | File path to write |
| `content` | string | ✅ | Content to write |

### `run_command`
Execute a shell command in the sandbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | ✅ | Shell command to execute |
| `timeout_ms` | number | ❌ | Timeout in milliseconds (default: 30000) |

**Returns:** `{ stdout, stderr, exitCode }`

### `kv_get` / `kv_set` / `kv_delete`
Key-value storage backed by SQLite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | ✅ | Storage key |
| `value` | string | ✅ (set) | Value to store |

---

## Web Tools

### `fetch_url`
Fetch and extract content from a URL.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | ✅ | URL to fetch |
| `extract_mode` | string | ❌ | `"markdown"` (default) or `"text"` |
| `max_chars` | number | ❌ | Truncate response at this length |

### `web_search`
Search the web and return results.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | Search query |
| `count` | number | ❌ | Number of results (default: 5) |

---

## Server Tools

### `start_server`
Start an HTTP server on a specified port.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `port` | number | ✅ | Port to listen on |
| `routes` | object[] | ✅ | Route definitions `[{method, path, handler}]` |

### `stop_server`
Stop a running HTTP server.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `port` | number | ✅ | Port of server to stop |

### `expose_port`
Expose a port to the public internet via Conway.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `port` | number | ✅ | Port to expose |
| `domain` | string | ❌ | Custom domain (if registered) |

---

## Scheduler Tools

### `schedule_task`
Schedule a recurring or one-shot task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Task identifier |
| `schedule` | string | ✅ | Cron expression or interval (e.g. `"*/5 * * * *"`, `"every 30m"`) |
| `command` | string | ✅ | Shell command or tool call to execute |

### `list_tasks`
List all scheduled tasks.

### `remove_task`
Remove a scheduled task by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Task name to remove |

---

## Migration Tools

### `create_backup`
Create a full or incremental backup of automaton state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | ❌ | `"full"` (default) or `"incremental"` |
| `encryption_key` | string | ❌ | Encrypt sensitive files (wallet) |
| `max_retained` | number | ❌ | Auto-prune backups exceeding this count |

**Returns:** `BackupInfo` with id, type, fileCount, size, path.

### `list_backups`
List all available backups with metadata.

### `restore_backup`
Restore state from a backup.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `backup_path` | string | ✅ | Path to backup directory |
| `categories` | string[] | ❌ | Selective restore: `db`, `config`, `skills`, `wallet`, `heartbeat`, `soul`, `all` |
| `dry_run` | boolean | ❌ | Preview without writing |
| `decryption_key` | string | ❌ | Decrypt encrypted files |

### `migrate_to_sandbox`
Export, import, or verify a cross-sandbox migration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | ✅ | `"export"`, `"import"`, or `"verify"` |
| `new_sandbox_id` | string | import | Target sandbox ID |
| `backup_path` | string | import/verify | Backup directory path |
| `encryption_key` | string | ❌ | Encryption/decryption key |

### `portable_export`
Export automaton state as a single portable file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `output_path` | string | ❌ | Output file path (default: `~/automaton-export.bin`) |
| `encryption_key` | string | ❌ | Encrypt sensitive files |

**Returns:** `{ filePath, sandboxId, fileCount, sizeBytes, exportedAt }`

### `portable_import`
Import state from a portable export file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Path to export file |
| `new_sandbox_id` | string | ✅ | Sandbox ID for this instance |
| `decryption_key` | string | ❌ | Decrypt sensitive files |

---

## Model Router Tools

### `model_stats`
View model usage statistics and cost breakdown.

### `set_model_preference`
Override model routing for specific task categories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | string | ✅ | Task category (e.g. `"code"`, `"chat"`) |
| `model` | string | ✅ | Model identifier |

---

## Collaboration Tools

### `send_message`
Send a message to another automaton via inbox relay.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | ✅ | Target agent address |
| `message` | string | ✅ | Message content |

### `check_inbox`
Check for incoming messages from other agents.

---

## Plugin Tools

### `install_plugin`
Install a plugin from a URL or local path.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | ✅ | Plugin URL or file path |

### `list_plugins`
List installed plugins and their status.

### `uninstall_plugin`
Remove an installed plugin.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Plugin name |

---

## Quota & Rate Limiting Tools

### `check_quota`
Check current rate limits and usage quotas.

### `set_quota`
Configure rate limits for a specific resource.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resource` | string | ✅ | Resource name |
| `limit` | number | ✅ | Max requests per window |
| `window_ms` | number | ✅ | Time window in milliseconds |

---

## Chain Tools

### `get_balance`
Get wallet balance across configured chains.

### `send_transaction`
Send a transaction on-chain.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | ✅ | Recipient address |
| `amount` | string | ✅ | Amount in ETH/USDC |
| `chain` | string | ❌ | Target chain (default: Base) |

### `register_identity`
Register on-chain via ERC-8004.

---

## Monitoring Tools

### `get_metrics`
Get Prometheus-compatible metrics snapshot.

### `set_alert`
Configure an alert rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Alert name |
| `condition` | string | ✅ | Condition expression |
| `action` | string | ✅ | Action on trigger |

---

## Webhook Tools

### `create_webhook`
Register a webhook endpoint.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | URL path to listen on |
| `secret` | string | ❌ | HMAC secret for verification |

### `list_webhooks`
List registered webhook endpoints.

---

## Security Tools

### `vault_store` / `vault_get` / `vault_delete`
Encrypted key-value storage for secrets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | ✅ | Secret key name |
| `value` | string | ✅ (store) | Secret value |
