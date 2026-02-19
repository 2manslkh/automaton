# Tutorials

Step-by-step guides for common automaton tasks.

---

## Tutorial 1: Deploy Your First Paid API

Create an HTTP endpoint that earns money via x402 micropayments.

### Step 1: Start the HTTP Server

The automaton can start a server on any available port:

```
Tool: start_http_server
Args: { "port": 3000 }
```

### Step 2: Add a Paid Route

Add an endpoint with x402 payment middleware. Callers must pay to access it:

```
Tool: add_route
Args: {
  "port": 3000,
  "method": "GET",
  "path": "/api/joke",
  "handler": "return { joke: 'Why do programmers prefer dark mode? Because light attracts bugs.' }",
  "x402": {
    "price": "0.001",
    "currency": "USDC"
  }
}
```

### Step 3: Expose the Port

Make the server accessible from the internet:

```
Tool: port_expose
Args: { "port": 3000 }
```

### Step 4: Register a Domain (Optional)

```
Tool: domain_register
Args: { "domain": "jokes.example.com", "port": 3000 }
```

### Step 5: Verify Revenue

Check that payments are being recorded:

```
Tool: financial_report
Args: { "period": "daily" }
```

### Using the API Scaffold

For a complete API service with boilerplate, use the API scaffold skill:

```
Tool: install_skill
Args: { "source": "api-service-template" }
```

This creates a full project structure with routes, middleware, documentation, and x402 integration.

---

## Tutorial 2: Set Up Webhooks

Receive and process external events from services like GitHub or Stripe.

### Step 1: Start the HTTP Server

```
Tool: start_http_server
Args: { "port": 4000 }
```

### Step 2: Register a Webhook

```
Tool: webhook_register
Args: {
  "name": "github-pushes",
  "path": "/webhooks/github",
  "processor": "github",
  "secret": "my-webhook-secret",
  "events": ["push", "pull_request"]
}
```

The `processor` field selects a built-in event processor. Available processors:
- `github` — GitHub webhook events
- `stripe` — Stripe payment events
- `custom` — Raw JSON passthrough

### Step 3: Configure the External Service

Point GitHub's webhook settings to your exposed URL:
- URL: `https://your-domain.com/webhooks/github`
- Secret: `my-webhook-secret`
- Events: Push, Pull Request

### Step 4: Process Events

Webhook events are queued for the agent loop. The automaton sees them as incoming messages and can respond — e.g., auto-deploying on push, or thanking contributors on PR.

### Step 5: Monitor Webhook Activity

```
Tool: webhook_list
```

---

## Tutorial 3: Use the Memory System

Store and recall information across sessions using structured memory.

### Episodic Memory (Events)

Store event-based memories with timestamps and importance:

```
Tool: memory_store
Args: {
  "type": "episodic",
  "content": "Deployed joke API, earned $0.50 in first hour",
  "tags": ["revenue", "api", "milestone"],
  "importance": 0.8
}
```

### Semantic Memory (Facts)

Store factual knowledge:

```
Tool: memory_store
Args: {
  "type": "semantic",
  "content": "x402 payments require USDC on Base network",
  "category": "technical",
  "tags": ["x402", "payments", "base"]
}
```

### Working Memory (Scratchpad)

Temporary context for the current task:

```
Tool: memory_store
Args: {
  "type": "working",
  "content": "Currently debugging route handler for /api/translate",
  "tags": ["current-task"]
}
```

### Searching Memory

```
Tool: memory_search
Args: {
  "query": "revenue milestones",
  "tags": ["revenue"],
  "limit": 10
}
```

### Memory Consolidation

Periodically consolidate working memory into long-term storage:

```
Tool: memory_consolidate
```

This moves important working memories into episodic/semantic storage and clears the scratchpad.

---

## Tutorial 4: Monitor with Prometheus

Set up metrics collection and alerting.

### Step 1: Built-in Metrics

The automaton automatically tracks:
- `automaton_turns_total` — Total agent turns executed
- `automaton_tool_calls_total` — Tool calls by name
- `automaton_credits_balance` — Current credit balance
- `automaton_response_latency_seconds` — Inference response time
- `automaton_errors_total` — Errors by type
- `automaton_revenue_total` — Total revenue earned
- `automaton_memory_count` — Stored memories by type

### Step 2: Expose Metrics Endpoint

The monitoring system exposes a Prometheus-compatible endpoint:

```
GET /metrics
```

This is automatically available when the HTTP server is running. Point your Prometheus instance at it.

### Step 3: Create Alerts

```
Tool: create_alert
Args: {
  "name": "low-credits",
  "metric": "automaton_credits_balance",
  "condition": "below",
  "threshold": 1.0,
  "action": "notify_creator"
}
```

```
Tool: create_alert
Args: {
  "name": "high-error-rate",
  "metric": "automaton_errors_total",
  "condition": "rate_above",
  "threshold": 10,
  "window": "5m",
  "action": "log_warning"
}
```

### Step 4: Grafana Dashboard (Optional)

Import the automaton Grafana dashboard for visualization. Use the dashboard tool to auto-deploy a status page:

```
Tool: deploy_dashboard
```

This creates a web-accessible status page showing real-time metrics, survival tier, recent activity, and financial summary.

### Step 5: Check Metrics Snapshot

```
Tool: metrics_snapshot
```

Returns current values for all tracked metrics.

---

## Tutorial 5: Multi-Chain Operations

Work with tokens across multiple networks.

### Check Balances

```
Tool: chain_balance
Args: { "network": "base" }
```

```
Tool: chain_list_networks
```

Supported networks: Ethereum mainnet, Base, Arbitrum, Optimism.

### Bridge Tokens

Move USDC from Arbitrum to Base:

```
Tool: chain_bridge
Args: {
  "from": "arbitrum",
  "to": "base",
  "token": "USDC",
  "amount": "10.0"
}
```

### Batched Transactions

Execute multiple operations in a single transaction:

```
Tool: chain_multicall
Args: {
  "network": "base",
  "calls": [
    { "to": "0x...", "data": "0x...", "value": "0" },
    { "to": "0x...", "data": "0x...", "value": "0" }
  ]
}
```
