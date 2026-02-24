# MCP Config-Driven Proxy Server

A TypeScript MCP server that acts as a pure HTTP proxy. Define tools in YAML — no code changes needed. Supports REST and XML-RPC upstreams, deployed on AWS Lambda or run locally.

---

## Table of Contents

- [Quick Start (Local)](#quick-start-local)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Running Locally](#running-locally)
- [Deploying to AWS Lambda](#deploying-to-aws-lambda)
- [Using with an MCP Client](#using-with-an-mcp-client)
- [curl Examples — Local](#curl-examples--local)
- [curl Examples — Deployed](#curl-examples--deployed)
- [Adding Tools](#adding-tools)
- [Project Structure](#project-structure)

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Set required env vars (any referenced in your config)
export API_KEY=your_api_key

# 3. Start the dev server
npm run dev
# → [mcp-proxy] Local server running → http://localhost:3000/mcp
# → [mcp-proxy] Loaded 4 tool(s): get_order, create_coupon, ...
```

---

## Configuration

All tools are defined in `config/tools.yaml` (or override with `MCP_CONFIG_PATH`).

### Minimal example — REST GET

```yaml
version: "1.0"
server:
  name: my-proxy
  description: My MCP proxy

defaults:
  timeout_ms: 5000
  auth:
    type: apikey
    header: Authorization
    value: Bearer ${API_KEY}   # resolved from env at startup

tools:
  - name: get_user
    description: Fetch a user by ID
    protocol: rest
    endpoint: https://api.example.com/users/{user_id}
    method: GET

    input:
      schema:
        - name: user_id
          type: string
          required: true
          description: The user ID
      mapping:
        - from: user_id
          to: user_id
          location: path

    output:
      mapping:
        - from: id
          to: user_id
          location: body
        - from: email
          to: email
          location: body
```

### Minimal example — XML-RPC

```yaml
  - name: get_stock
    description: Check warehouse stock
    protocol: xmlrpc
    endpoint: https://erp.example.com/RPC2
    xmlrpc_method: inventory.getStock

    input:
      schema:
        - name: product_id
          type: integer
          required: true
          description: Numeric product ID
      mapping:
        - from: product_id
          to: param
          location: param
          index: 0
          type: int

    output:
      mapping:
        - from: quantity
          to: stock_level
          location: body
```

Full schema reference: [docs/main.md](docs/main.md) | Architecture: [docs/architecture.md](docs/architecture.md)

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MCP_CONFIG_PATH` | Path to tools YAML config | `./config/tools.yaml` |
| `MCP_SERVER_NAME` | Override the server name from config | — |
| `PORT` | Local dev server port | `3000` |
| Any `${VAR}` in auth | Injected into config at bootstrap | Required if referenced |

---

## Running Locally

```bash
npm run dev                    # hot-reload via tsx watch
PORT=8080 npm run dev          # custom port

# With multiple env vars
API_KEY=secret OTHER=value npm run dev
```

The server exposes a single endpoint: `POST /mcp` (MCP Streamable HTTP transport).

---

## Deploying to AWS Lambda

```bash
# Build and deploy (requires AWS credentials configured)
npm run deploy

# Deploy to a specific region or stage
npx serverless deploy --stage prod --region eu-west-1
```

The Lambda is wired to API Gateway HTTP API. After deploy, Serverless prints the endpoint URL:

```
endpoint: POST - https://abc123.execute-api.us-east-1.amazonaws.com/mcp
```

Use that URL in place of `http://localhost:3000/mcp` in all examples below.

---

## Using with an MCP Client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "my-proxy": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For deployed Lambda:

```json
{
  "mcpServers": {
    "my-proxy": {
      "url": "https://abc123.execute-api.us-east-1.amazonaws.com/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add my-proxy --transport http http://localhost:3000/mcp
```

---

## curl Examples — Local

All MCP Streamable HTTP requests require:
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

Responses are Server-Sent Events (SSE) — each line prefixed with `data:`.

### Initialize the MCP session

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0" }
    }
  }'
```

**Response:**
```
event: message
data: {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"mcp-proxy","version":"1.0"}},"jsonrpc":"2.0","id":1}
```

---

### List available tools

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

---

### Call a tool — REST GET

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "get_order",
      "arguments": {
        "order_id": "ORD-123",
        "include_items": true
      }
    }
  }'
```

**What happens internally:**
```
GET https://api.example.com/orders/ORD-123?include_items=true
Authorization: Bearer <API_KEY>
```

**Response:**
```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"order_id\":\"ORD-123\",\"status\":\"shipped\",\"total\":149.99}"}]},"jsonrpc":"2.0","id":3}
```

---

### Call a tool — REST POST with nested body

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "create_coupon",
      "arguments": {
        "code": "SAVE20",
        "discount_percent": 20,
        "expires_at": "2025-12-31T00:00:00Z"
      }
    }
  }'
```

**What happens internally:**
```json
POST https://api.example.com/coupons
{
  "coupon_code": "SAVE20",
  "discount": { "type": "percent", "percentage": 20.0 },
  "expiry_date": "2025-12-31T00:00:00Z"
}
```

---

### Call a tool — XML-RPC

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "get_product_stock",
      "arguments": {
        "product_id": 4821,
        "warehouse": "EU-NL"
      }
    }
  }'
```

**What happens internally:**
```xml
POST https://erp.example.com/RPC2
Content-Type: text/xml

<?xml version="1.0"?>
<methodCall>
  <methodName>inventory.getStock</methodName>
  <params>
    <param><value><int>4821</int></value></param>
    <param><value><string>EU-NL</string></value></param>
  </params>
</methodCall>
```

---

### Error response example

When a required field is missing or upstream returns an error, `isError: true` is set and the content contains a structured payload:

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\n  \"error\": true,\n  \"code\": \"UPSTREAM_ERROR\",\n  \"message\": \"Upstream returned 404\",\n  \"upstream_status\": 404\n}"}],"isError":true},"jsonrpc":"2.0","id":3}
```

| Code | Trigger |
|---|---|
| `CONFIG_INVALID` | Config fails schema validation at startup |
| `MAPPING_ERROR` | Required parameter missing, no default |
| `UPSTREAM_ERROR` | Upstream returned non-2xx |
| `XMLRPC_FAULT` | XML-RPC faultCode returned |
| `TIMEOUT` | Request exceeded `timeout_ms` |
| `TRANSFORM_ERROR` | Type coercion or transform failed |

---

## curl Examples — Deployed

Replace the base URL with your API Gateway endpoint. Everything else is identical.

```bash
BASE=https://abc123.execute-api.us-east-1.amazonaws.com

# Initialize
curl -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# List tools
curl -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call a tool
curl -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_order","arguments":{"order_id":"ORD-123"}}}'
```

---

## Adding Tools

1. Edit `config/tools.yaml` — add a new entry under `tools:`
2. Restart the dev server (`npm run dev`) — tools are loaded at startup
3. For Lambda: redeploy (`npm run deploy`)

No code changes required.

---

## Project Structure

```
mcp-proxy/
├── src/
│   ├── index.ts              # Lambda entrypoint (AWS API Gateway)
│   ├── local.ts              # Local dev HTTP server
│   ├── server.ts             # MCP server bootstrap + tool registration
│   ├── loader.ts             # Config loader, validator, env var resolver
│   ├── router.ts             # Tool call dispatcher + error handling
│   ├── protocols/
│   │   ├── rest.ts           # REST HTTP handler
│   │   └── xmlrpc.ts         # XML-RPC request builder + response parser
│   ├── transform/
│   │   ├── inbound.ts        # MCP args → upstream request mapping
│   │   ├── outbound.ts       # Upstream response → MCP response mapping
│   │   └── transforms.ts     # 12 built-in value transforms
│   └── types.ts              # All TypeScript types
├── config/
│   └── tools.yaml            # Tool definitions (edit this)
├── schema/
│   └── config.schema.json    # AJV schema — validates tools.yaml at startup
├── docs/
│   ├── main.md               # Full technical specification
│   └── architecture.md       # Code and architecture deep-dive
├── package.json
├── tsconfig.json
└── serverless.yml            # Lambda + API Gateway deployment config
```
