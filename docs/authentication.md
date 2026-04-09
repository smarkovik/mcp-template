# Authentication

This proxy has two independent authentication layers:

| Layer | Direction | Controls |
|---|---|---|
| **Proxy auth** | Client → Proxy | Who can call your MCP server |
| **Upstream auth** | Proxy → API | How the proxy authenticates with third-party APIs |

---

## 1. Proxy-level Authentication (Client → Proxy)

Protects the MCP endpoint itself. When enabled, every MCP client must supply a valid API key with each request.

### Enabling proxy auth

Set the `PROXY_API_KEY` environment variable before starting the server:

```bash
export PROXY_API_KEY="my-secure-random-key"
npm run dev          # local
npm run start        # production
```

When the variable is **not set**, the server starts in open mode (no auth) — safe for local development, not for production.

The server logs whether auth is active at startup:
```
[mcp-proxy] Proxy API key authentication ENABLED (PROXY_API_KEY is set)
# or
[mcp-proxy] Warning: Proxy API key auth is DISABLED. Set PROXY_API_KEY to protect this endpoint.
```

### How clients supply the key

Two equivalent header formats are accepted:

```http
Authorization: Bearer my-secure-random-key
```
```http
X-Api-Key: my-secure-random-key
```

The `Bearer` prefix is matched case-insensitively. The key itself is case-sensitive.

### Rejected requests

Requests with a missing or incorrect key receive HTTP `401 Unauthorized`:

```json
{
  "error": true,
  "code": "UNAUTHORIZED",
  "message": "Invalid or missing API key. Provide it via \"Authorization: Bearer <key>\" or \"X-Api-Key: <key>\"."
}
```

### Example: curl with auth

```bash
# Standard Bearer token
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer my-secure-random-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Alternative X-Api-Key header
curl -X POST http://localhost:3000/mcp \
  -H "X-Api-Key: my-secure-random-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Example: Claude Desktop config with auth

```json
{
  "mcpServers": {
    "my-proxy": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"],
      "env": {
        "MCP_REMOTE_HEADER_AUTHORIZATION": "Bearer my-secure-random-key"
      }
    }
  }
}
```

### Lambda / AWS deployment

When deploying to AWS Lambda, set `PROXY_API_KEY` in the Lambda environment variables (via the console, CDK, or `serverless.yml`):

```yaml
# serverless.yml
provider:
  environment:
    PROXY_API_KEY: ${env:PROXY_API_KEY}
```

API Gateway will pass the `Authorization` and `X-Api-Key` headers through to the Lambda function unchanged.

---

## 2. Upstream Authentication (Proxy → API)

Controls how the proxy authenticates against the third-party APIs it wraps. Configured per-tool (or as a default) in `config/tools.yaml`.

### API Key (`type: apikey`)

Injects a static header with a (usually secret) value. The value is read from an environment variable at startup.

```yaml
defaults:
  auth:
    type: apikey
    header: Authorization
    value: Bearer ${OPENAI_API_KEY}   # env var interpolated at startup

tools:
  - name: get_weather
    # inherits defaults.auth — no auth: block needed

  - name: search_products
    auth:                              # override for this tool only
      type: apikey
      header: X-Api-Key
      value: ${SHOPIFY_API_KEY}
```

Supported `header` values:
- `Authorization` (e.g. `Bearer sk-...`, `Token abc123`)
- `X-Api-Key`
- Any other custom header name

### Basic Auth (`type: basic`)

Encodes `username:password` as a Base64 `Authorization: Basic …` header. Both fields support `${ENV_VAR}` interpolation.

```yaml
tools:
  - name: get_order
    auth:
      type: basic
      username: ${API_USER}
      password: ${API_PASS}
```

### No Auth (`type: none`)

Explicitly opt out of authentication for a specific tool, even when a default auth is configured:

```yaml
defaults:
  auth:
    type: apikey
    header: Authorization
    value: Bearer ${GLOBAL_KEY}

tools:
  - name: get_public_data
    auth:
      type: none     # public endpoint — skip the default auth header
```

### Inheritance & override

- `defaults.auth` applies to every tool that does not have its own `auth:` block.
- A tool-level `auth:` block completely replaces the default for that tool.
- Setting `auth: { type: none }` at the tool level disables auth for that tool even if a default exists.

### Environment variable interpolation

Any `${VAR_NAME}` placeholder in `auth.value`, `auth.username`, or `auth.password` is resolved from the process environment **at startup**. The raw variable name is never stored after interpolation — it exists only in memory during the server's lifetime.

If a referenced variable is missing, the server throws `CONFIG_INVALID` and refuses to start:
```
CONFIG_INVALID: Environment variable "API_KEY" is not set
```

---

## Security Checklist

- [ ] `PROXY_API_KEY` is set in production (never left unset).
- [ ] `PROXY_API_KEY` is a long, randomly generated string (e.g. `openssl rand -hex 32`).
- [ ] Upstream API keys are stored as environment variables, not hardcoded in `tools.yaml`.
- [ ] `tools.yaml` is not committed with real credential values.
- [ ] HTTPS is used in production (API Gateway provides this automatically for Lambda).
- [ ] `PROXY_API_KEY` is rotated regularly and after any suspected exposure.
