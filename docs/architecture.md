# Architecture & Code Guide

This document explains how the MCP proxy server is structured, how each module works, and how data flows through the system from an incoming MCP tool call to an upstream HTTP response and back.

---

## Table of Contents

- [Design Principles](#design-principles)
- [System Overview](#system-overview)
- [Bootstrap Flow](#bootstrap-flow)
- [Request Lifecycle](#request-lifecycle)
- [Module Reference](#module-reference)
  - [types.ts](#typests)
  - [loader.ts](#loaderts)
  - [server.ts](#serverts)
  - [router.ts](#routerts)
  - [transform/inbound.ts](#transforminboundts)
  - [transform/outbound.ts](#transformoutboundts)
  - [transform/transforms.ts](#transformtransformsts)
  - [protocols/rest.ts](#protocolsrestts)
  - [protocols/xmlrpc.ts](#protocolsxmlrpcts)
  - [local.ts](#localts)
  - [index.ts](#indexts)
- [Dual Entrypoint Architecture](#dual-entrypoint-architecture)
- [Config Validation](#config-validation)
- [Parameter Mapping In Depth](#parameter-mapping-in-depth)
- [XML-RPC Implementation](#xml-rpc-implementation)
- [Error Handling](#error-handling)
- [Adding a New Protocol](#adding-a-new-protocol)

---

## Design Principles

1. **No business logic in code** — all tool behaviour is driven by `config/tools.yaml`. Adding, changing or removing a tool never requires a code change.
2. **Fail loudly at startup** — config is validated against a JSON Schema at bootstrap. If invalid, the process exits with `CONFIG_INVALID` before accepting any traffic.
3. **Secrets never stored** — env var interpolation (`${VAR}`) is resolved once at startup into the in-memory config object. The YAML file on disk never contains live secrets.
4. **Stateless by design** — no sessions, no in-memory state between requests. Safe for Lambda cold starts and horizontal scaling.

---

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client (LLM)                     │
└───────────────────────┬─────────────────────────────────┘
                        │  JSON-RPC 2.0 over HTTP (SSE)
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Entrypoint (local.ts / index.ts)           │
│         StreamableHTTP / WebStandardStreamableHTTP      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    server.ts                            │
│   McpServer — registers tools from config at startup   │
└───────────────────────┬─────────────────────────────────┘
                        │  tool call (name + args)
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    router.ts                            │
│   Looks up tool config, orchestrates transform+call    │
└────────┬──────────────────────────────┬────────────────┘
         │                              │
         ▼                              ▼
┌────────────────┐            ┌──────────────────────┐
│ transform/     │            │ transform/            │
│ inbound.ts     │            │ outbound.ts           │
│ (MCP→upstream) │            │ (upstream→MCP)        │
└────────┬───────┘            └──────────┬───────────┘
         │                              │
         ▼                              │
┌────────────────────────────┐          │
│     protocols/             │          │
│   rest.ts | xmlrpc.ts      │──────────┘
│  (HTTP call to upstream)   │
└────────────────────────────┘
```

---

## Bootstrap Flow

```
process start
    │
    ├─ loadConfig()                       [loader.ts]
    │    ├─ read YAML file
    │    ├─ parse YAML → JS object
    │    ├─ validate against JSON Schema  → CONFIG_INVALID if bad
    │    └─ interpolate ${ENV_VAR} in auth values
    │
    ├─ createMcpServer(config)            [server.ts]
    │    └─ for each tool in config:
    │         └─ server.tool(name, description, zodSchema, handler)
    │              └─ zodSchema built from tool.input.schema[]
    │
    └─ transport.connect(mcpServer)
         └─ ready to accept MCP requests
```

Config and the MCP server are created **once** and reused across all requests (warm Lambda invocations, all local requests). Only the transport layer is per-request on Lambda.

---

## Request Lifecycle

```
MCP client sends: tools/call { name: "get_order", arguments: { order_id: "ORD-123" } }
    │
    ▼
server.ts → tool handler fires
    │
    ▼
router.ts → routeToolCall("get_order", { order_id: "ORD-123" }, config)
    │
    ├─ find ToolDefinition by name
    ├─ resolve timeout (tool > defaults > 5000ms)
    ├─ resolve default headers + auth
    │
    ▼
transform/inbound.ts → applyInboundMapping(args, tool, headers, auth)
    ├─ build auth header (apikey / basic / none)
    ├─ for each MappingField:
    │    ├─ resolve value (from args, static, or default)
    │    ├─ apply type coercion (int, float, boolean…)
    │    ├─ apply transform (uppercase, iso_to_unix…)
    │    └─ place at location (path / query / body / header / param / struct)
    └─ returns: { url, method, headers, body, xmlrpcParams? }
    │
    ▼
protocols/rest.ts OR protocols/xmlrpc.ts
    ├─ REST:   fetch(url, { method, headers, body })
    └─ XMLRPC: build XML → fetch → parse XML response
    │
    ▼
transform/outbound.ts → applyOutboundMapping(upstreamBody, upstreamHeaders, mapping)
    ├─ for each MappingField:
    │    ├─ read from body (dot-notation path) or response header
    │    ├─ apply type coercion + transform
    │    └─ write to result object as field.to
    └─ returns: Record<string, unknown>
    │
    ▼
server.ts → wrap result in MCP content block
    └─ { content: [{ type: "text", text: JSON.stringify(result) }] }
    │
    ▼
MCP client receives JSON-RPC response over SSE
```

---

## Module Reference

### `types.ts`

All TypeScript interfaces. Nothing is imported from here at runtime — types only.

Key types:

| Type | Purpose |
|---|---|
| `ServerConfig` | Top-level parsed config shape |
| `ToolDefinition` | One tool entry from `tools:` array |
| `MappingField` | One `from→to` mapping rule |
| `AuthConfig` | Auth strategy: `apikey`, `basic`, `none` |
| `McpErrorPayload` | Structured error returned to the MCP client |
| `BuiltinTransform` | Union of the 12 allowed transform names |

`McpErrorPayload` has `[key: string]: unknown` index signature so it can be returned as `Record<string, unknown>` from the router without casting.

---

### `loader.ts`

**Responsibility:** Load, validate and prepare the config for use.

```
loadConfig()
  ├─ readFileSync(MCP_CONFIG_PATH)
  ├─ js-yaml parse
  ├─ AJV validate against schema/config.schema.json
  │    └─ throws CONFIG_INVALID with joined error messages on failure
  └─ resolveAuthEnvVars(config)
       └─ replaces ${VAR} in auth.value / auth.username / auth.password
            └─ throws CONFIG_INVALID if env var is missing
```

**AJV usage:** AJV ships as CommonJS. To use it from ESM we bypass its TypeScript types entirely and `require()` it with a hand-written interface describing only what we need (`compile`, `errors`).

**Env var interpolation:** `${VAR}` anywhere in an auth string value. Regex: `/\$\{([^}]+)\}/g`. Resolved once at startup, never read again from the file.

---

### `server.ts`

**Responsibility:** Create the `McpServer` and register every tool from config.

```typescript
for (const tool of config.tools) {
  const zodShape = buildZodSchema(tool.input.schema);
  server.tool(tool.name, tool.description, zodShape, async (args) => { ... });
}
```

**Zod schema generation** — `buildZodSchema()` walks `tool.input.schema[]` and produces a `Record<string, z.ZodTypeAny>` shape:

| Config `type` | Zod type |
|---|---|
| `string` | `z.string()` |
| `number` | `z.number()` |
| `integer` | `z.number().int()` |
| `boolean` | `z.boolean()` |
| `object` | `z.record(z.string(), z.unknown())` |
| `array` | `z.array(z.unknown())` |

Optional fields get `.optional()`. Fields with a default get `.default(value)`. Both are applied after `.describe(description)` so the LLM sees the description.

The MCP SDK uses this Zod shape to generate the JSON Schema shown to the LLM under `tools/list`.

---

### `router.ts`

**Responsibility:** Orchestrate a single tool call end-to-end; catch and format all errors.

```typescript
export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  config: ServerConfig
): Promise<Record<string, unknown>>
```

Steps:
1. Find tool by name → `MAPPING_ERROR` if not found
2. Resolve `timeoutMs` (tool → defaults → 5000)
3. `applyInboundMapping` → catch and return `MAPPING_ERROR` / `TRANSFORM_ERROR`
4. Dispatch to `callRest` or `callXmlRpc` → catch and return `UPSTREAM_ERROR` / `XMLRPC_FAULT` / `TIMEOUT`
5. `applyOutboundMapping` → return result

Error objects carry `.code`, `.upstream_status`, `.upstream_body` as properties on the thrown `Error`. `extractError()` reads these to build the `McpErrorPayload`.

---

### `transform/inbound.ts`

**Responsibility:** Convert MCP tool arguments into an upstream request.

```typescript
applyInboundMapping(args, tool, defaultHeaders, defaultAuth) → InboundResult
```

`InboundResult`:
```typescript
{
  url: string;          // final URL (path vars substituted, query appended)
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  xmlrpcParams?: unknown[];
}
```

**Mapping locations:**

| Location | Action |
|---|---|
| `path` | `url.replace("{field.to}", value)` |
| `query` | appended as `URLSearchParams` |
| `body` | `setDeep(body, field.to, value)` — supports dot-notation |
| `header` | added to headers map |
| `param` | placed in `xmlrpcPositional[index]` |
| `struct` | merged into `xmlrpcStructs[index]` object |

**`setDeep`** — splits `"discount.percentage"` on `.` and creates nested objects automatically:
```
setDeep({}, "discount.percentage", 20.0)
→ { discount: { percentage: 20.0 } }
```

**Static values** — if `field.static` is present, that literal value is used regardless of `args`.

**XML-RPC param assembly** — after all fields are processed, positional params and struct params are merged into a single array indexed by `field.index`.

---

### `transform/outbound.ts`

**Responsibility:** Map an upstream response body/headers to the MCP result object.

```typescript
applyOutboundMapping(upstreamBody, upstreamHeaders, mapping) → Record<string, unknown>
```

- `location: body` → reads `from` as a dot-notation path with `getDeep()`
- `location: header` → reads `upstreamHeaders[from.toLowerCase()]`
- Any field missing from the upstream and without a `default` is silently omitted
- Optional type coercion and transforms are applied after reading

`getDeep` is the mirror of `setDeep` — walks dot-notation paths into nested objects.

---

### `transform/transforms.ts`

**Responsibility:** Implement the 12 built-in transform functions and the type coercer.

```typescript
applyTransform(value: unknown, transform: BuiltinTransform): unknown
coerceType(value: unknown, type: string): unknown
```

All transforms throw a descriptive `TRANSFORM_ERROR: ...` message on failure (e.g. `Cannot convert "abc" to int`). The exhaustive `never` check on the `switch` default ensures TypeScript catches any missing cases at compile time.

| Transform | Notes |
|---|---|
| `iso_to_unix` | Uses `new Date(str).getTime() / 1000` — throws on invalid ISO |
| `unix_to_iso` | `new Date(n * 1000).toISOString()` |
| `base64_encode/decode` | Uses Node.js `Buffer` |
| `json_stringify/parse` | `JSON.stringify` / `JSON.parse` — throws on parse failure |
| `to_boolean` | Accepts `true/false/1/0` (case-insensitive), throws otherwise |

---

### `protocols/rest.ts`

**Responsibility:** Execute a REST HTTP request and return `{ body, headers, status }`.

Uses native `fetch` (Node 20+). `AbortSignal.timeout(ms)` handles the timeout — throws a `TimeoutError` which is mapped to the `TIMEOUT` error code.

Content-Type handling:
- Requests: `application/json` is set automatically when there is a body and method is not GET/DELETE
- Responses: if `content-type` contains `application/json`, body is parsed as JSON; otherwise wrapped as `{ _raw: "<text>" }`

Non-2xx responses throw with `.upstream_status` and `.upstream_body` attached.

---

### `protocols/xmlrpc.ts`

**Responsibility:** Build an XML-RPC `<methodCall>`, send it, parse the `<methodResponse>`.

**No external XML parsing dependency.** The module has two paths:

1. **`DOMParser` path** (browser / modern runtimes) — uses `new DOMParser().parseFromString(xml, 'text/xml')` and walks the DOM
2. **Regex fallback** (`parseWithRegex`) — used when `DOMParser` is unavailable (Lambda Node 20). Handles struct responses and fault detection with targeted regex patterns

**XML builder** — `valueToXml(value)` recursively converts JS values to XML-RPC type tags:

| JS type | XML-RPC tag |
|---|---|
| `boolean` | `<boolean>1</boolean>` |
| `integer` | `<int>` |
| `float` | `<double>` |
| `string` | `<string>` |
| `Array` | `<array><data>…</data></array>` |
| `object` | `<struct><member>…</member></struct>` |
| `null/undefined` | `<nil/>` |

Faults from the server (`<fault>`) are thrown as `XMLRPC_FAULT` errors with `faultString` and `faultCode` in the payload.

---

### `local.ts`

**Responsibility:** Dev server — Node.js HTTP + `StreamableHTTPServerTransport`.

```
loadConfig() → createMcpServer() → new StreamableHTTPServerTransport()
→ mcpServer.connect(transport)
→ createServer(async (req, res) => transport.handleRequest(req, res))
→ listen(PORT)
```

The transport and MCP server are created **once** (top-level `await` in the ESM module). All requests share the same transport instance (stateless mode — no session IDs).

`StreamableHTTPServerTransport` accepts Node.js `IncomingMessage` and `ServerResponse` directly — no manual body reading or header parsing needed.

Requests to any path other than `/mcp` get a plain `404 Not found`.

---

### `index.ts`

**Responsibility:** Lambda handler — `WebStandardStreamableHTTPServerTransport`.

```typescript
export async function handler(event, context): Promise<APIGatewayProxyResultV2>
```

Unlike `local.ts`, a **new transport is created per invocation** because Lambda may reuse the same process across multiple concurrent requests (each gets its own handler call). The MCP server itself is created once at cold-start and reused.

The API Gateway event is converted to a Web Standard `Request`:
```typescript
new Request(url, { method, headers: new Headers(event.headers), body })
```

The `WebStandardStreamableHTTPServerTransport.handleRequest(request)` returns a Web Standard `Response`, which is unpacked into the API Gateway result format (`statusCode`, `headers`, `body`).

---

## Dual Entrypoint Architecture

```
                     ┌─────────────┐
                     │  server.ts  │  ← shared
                     │  loader.ts  │
                     │  router.ts  │
                     └──────┬──────┘
                            │
              ┌─────────────┴──────────────┐
              │                            │
     ┌────────▼────────┐        ┌──────────▼────────┐
     │    local.ts     │        │    index.ts        │
     │                 │        │                    │
     │ StreamableHTTP  │        │ WebStandard        │
     │ Transport       │        │ StreamableHTTP     │
     │ (Node HTTP)     │        │ Transport          │
     │                 │        │ (Web Request/      │
     │ npm run dev     │        │  Response)         │
     │ localhost:3000  │        │ AWS Lambda         │
     └─────────────────┘        └────────────────────┘
```

Both entrypoints share 100% of the application logic. The only difference is which MCP SDK transport adapts the incoming HTTP request into MCP protocol calls.

---

## Config Validation

`schema/config.schema.json` is a JSON Schema (draft-07) compiled by AJV at startup.

Key validation rules:
- `tools[].name` must match `/^[a-z][a-z0-9_]*$/` — snake_case only, so it's a valid MCP tool ID
- `tools[].protocol` must be `rest` or `xmlrpc`
- `mapping[].location` is an enum: `path | query | body | header | param | struct`
- `mapping[].transform` is an enum of the 12 built-in names
- `additionalProperties: false` on all objects — any unknown key in the YAML is a validation error

The `format: "uri"` keyword is intentionally omitted from the endpoint field — AJV v8 requires the `ajv-formats` plugin for format validation, and URI format errors are better surfaced at runtime with a meaningful `UPSTREAM_ERROR`.

---

## Parameter Mapping In Depth

Each `MappingField` is processed in order:

```
1. Resolve value
   ├─ if field.static is set → use it (ignore field.from)
   ├─ else → value = args[field.from]
   └─ if value is null/undefined → use field.default
        └─ if still undefined and field is required → MAPPING_ERROR

2. Coerce type (field.type)
   e.g. type: "int" → parseInt(value)

3. Apply transform (field.transform)
   e.g. transform: "uppercase" → value.toUpperCase()

4. Place at destination (field.location)
   path   → substitute {field.to} in URL
   query  → add to URLSearchParams
   body   → setDeep(body, "a.b.c", value)
   header → headers[field.to] = value
   param  → xmlrpcPositional.set(field.index, value)
   struct → xmlrpcStructs.get(field.index)[field.to] = value
```

Note: `required` is enforced by the Zod schema at the MCP layer (the SDK validates args before the handler fires). The `MAPPING_ERROR` in the mapping layer is a secondary safety net for cases where `default` is absent on an optional field that happens to be missing.

---

## XML-RPC Implementation

### Request building

Params are assembled from two maps keyed by `index`:
- `xmlrpcPositional` — scalar values at position `index`
- `xmlrpcStructs` — `Record<string, unknown>` objects at position `index`

After all mapping fields are processed, the final array is built:
```
max index = Math.max(all indexes)
params = [0..max].map(i => positional[i] ?? struct[i] ?? null)
```

This supports mixed calling conventions like `method(int, string, struct)`.

### Response parsing

The parser tries `DOMParser` first. On Lambda (Node 20 without DOM), it falls back to `parseWithRegex`:

1. Check for `<fault>` → extract `faultString` + `faultCode`
2. Match `<struct>` block → extract `<member>` pairs with tag-based type detection
3. Return `{ fault: boolean, value: unknown }`

The regex path handles the common case (struct response). Deeply nested or array responses will work correctly via the `DOMParser` path on runtimes that support it.

---

## Error Handling

All errors thrown anywhere in the call chain are caught by `router.ts` and converted to a `McpErrorPayload`:

```typescript
interface McpErrorPayload {
  error: true;
  code: string;        // one of the six error codes
  message: string;
  upstream_status?: number;
  upstream_body?: unknown;
}
```

This object is JSON-stringified and returned as the `text` content of the MCP tool result with `isError: true`. The MCP client receives a well-formed response (not an exception), which allows LLMs to reason about the error and potentially recover.

---

## Adding a New Protocol

To add a protocol (e.g. GraphQL):

1. Add `'graphql'` to the `Protocol` union in `types.ts`
2. Add `'graphql'` to the `protocol` enum in `schema/config.schema.json`
3. Create `src/protocols/graphql.ts` implementing:
   ```typescript
   export async function callGraphQL(
     inbound: InboundResult,
     tool: ToolDefinition,
     timeoutMs: number
   ): Promise<{ body: Record<string, unknown>; headers: Record<string, string>; status: number }>
   ```
4. Add a branch in `router.ts`:
   ```typescript
   } else if (tool.protocol === 'graphql') {
     response = await callGraphQL(inbound, tool, timeoutMs);
   }
   ```
5. Extend `MappingLocation` if the new protocol needs new location types

No changes to `server.ts`, `loader.ts`, `transform/`, or the entrypoints.
