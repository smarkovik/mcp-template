# MCP Config-Driven Proxy Server — Technical Specification

## Overview

A TypeScript MCP server that acts as a pure HTTP proxy. It reads a configuration file at bootstrap, auto-registers MCP tools from that config, and routes incoming tool calls to upstream endpoints — either REST or XML-RPC — with configurable parameter transformation in both directions.

**Key constraints:**
- No business logic in code — only in config
- Transformation is limited to: parameter mapping, type coercion, protocol translation
- No chaining, no conditional logic, no side effects beyond the HTTP call
- Deployed as AWS Lambda with API Gateway (Streamable HTTP transport)

---

## Project Structure

```
mcp-proxy/
├── src/
│   ├── index.ts              # Lambda entrypoint
│   ├── server.ts             # MCP server bootstrap
│   ├── loader.ts             # Config loader + validator
│   ├── router.ts             # Tool call router
│   ├── protocols/
│   │   ├── rest.ts           # REST handler
│   │   └── xmlrpc.ts         # XML-RPC handler
│   ├── transform/
│   │   ├── inbound.ts        # Request param transformation
│   │   └── outbound.ts       # Response transformation
│   └── types.ts              # All TypeScript types
├── config/
│   └── tools.yaml            # Tool definitions (the template)
├── schema/
│   └── config.schema.json    # JSON Schema for config validation
├── package.json
├── tsconfig.json
└── serverless.yml            # Lambda deployment config
```

---

## Configuration File Specification

Location: `config/tools.yaml` (overridable via `MCP_CONFIG_PATH` env var)

### Top-Level Structure

```yaml
version: "1.0"
server:
  name: string               # MCP server name
  description: string        # MCP server description

defaults:
  timeout_ms: 5000           # Default request timeout
  auth: AuthConfig           # Default auth (can be overridden per tool)
  headers: Record<string, string>  # Default headers added to all requests

tools:
  - ToolDefinition
  - ToolDefinition
```

---

## ToolDefinition Schema

```yaml
name: string                 # Tool name (snake_case, used as MCP tool ID)
description: string          # Human-readable description shown to LLM
protocol: rest | xmlrpc      # Upstream protocol
endpoint: string             # Target URL (supports {variable} path substitution)
method: GET | POST | PUT | PATCH | DELETE  # HTTP method (REST only)
xmlrpc_method: string        # XML-RPC method name (xmlrpc only)
timeout_ms: number           # Override default timeout
auth: AuthConfig             # Override default auth
headers: Record<string, string>  # Additional headers (merged with defaults)

input:
  schema: ParameterSchema    # Defines what the MCP tool accepts
  mapping: MappingDefinition # How input maps to the upstream request

output:
  mapping: MappingDefinition # How upstream response maps to MCP response
```

---

## AuthConfig Schema

```yaml
# Option 1: API Key
type: apikey
header: Authorization        # Header name
value: Bearer ${API_KEY}     # Supports env var interpolation

# Option 2: Basic Auth
type: basic
username: ${BASIC_USER}
password: ${BASIC_PASS}

# Option 3: No auth
type: none
```

Env var interpolation syntax: `${ENV_VAR_NAME}` — resolved at bootstrap, never stored in config values.

---

## ParameterSchema

Defines the MCP tool's input interface. These become the tool's JSON Schema that the LLM sees.

```yaml
input:
  schema:
    - name: string           # Parameter name
      type: string | number | integer | boolean | object | array
      required: boolean
      description: string    # Shown to LLM
      default: any           # Optional default value
```

### Example

```yaml
input:
  schema:
    - name: order_id
      type: string
      required: true
      description: The unique order identifier

    - name: include_items
      type: boolean
      required: false
      default: false
      description: Whether to include line items in the response
```

---

## MappingDefinition

The mapping section defines how data flows between the MCP layer and the upstream endpoint. It applies in both directions:

- **input.mapping** — MCP tool arguments → upstream request
- **output.mapping** — upstream response → MCP tool response

### Mapping Target Locations

For REST requests, parameters can be placed in:

| Location | Description |
|---|---|
| `path` | URL path variable `{variable}` |
| `query` | URL query string `?key=value` |
| `body` | JSON request body |
| `header` | HTTP header |

For XML-RPC requests:
| Location | Description |
|---|---|
| `param` | Positional XML-RPC method parameter (by index) |
| `struct` | Named field inside an XML-RPC struct parameter |

For output mapping:
| Location | Description |
|---|---|
| `body` | JSON response body field (dot-notation path) |
| `header` | Response header |

### Mapping Field Definition

```yaml
mapping:
  - from: string        # Source field name (from MCP input or upstream response)
    to: string          # Destination field name/path
    location: string    # Where to place it (see above)
    type: string        # Optional: coerce type (string, int, float, boolean)
    transform: string   # Optional: built-in transform (see Transforms)
    default: any        # Optional: value if source field is missing/null
    index: number       # XML-RPC only: positional param index (0-based)
    static: any         # Optional: ignore `from`, always send this static value
```

---

## Parameter Mapping Examples

### Example 1: REST GET — path + query parameters

**Tool:** `get_order`  
**Upstream:** `GET https://api.example.com/orders/{order_id}?include_items=true`

```yaml
- name: get_order
  description: Fetch a single order by ID
  protocol: rest
  endpoint: https://api.example.com/orders/{order_id}
  method: GET

  input:
    schema:
      - name: order_id
        type: string
        required: true
        description: The order ID to fetch
      - name: include_items
        type: boolean
        required: false
        default: false
        description: Include line items

    mapping:
      - from: order_id
        to: order_id
        location: path

      - from: include_items
        to: include_items
        location: query
        type: boolean

  output:
    mapping:
      - from: id
        to: order_id
        location: body
      - from: status
        to: status
        location: body
      - from: total_amount
        to: total
        location: body
```

**MCP call:**
```json
{ "order_id": "ORD-123", "include_items": true }
```

**Upstream request:**
```
GET https://api.example.com/orders/ORD-123?include_items=true
```

**Upstream response:**
```json
{ "id": "ORD-123", "status": "shipped", "total_amount": 149.99 }
```

**MCP response:**
```json
{ "order_id": "ORD-123", "status": "shipped", "total": 149.99 }
```

---

### Example 2: REST POST — JSON body

**Tool:** `create_coupon`  
**Upstream:** `POST https://api.example.com/coupons`

```yaml
- name: create_coupon
  description: Create a discount coupon
  protocol: rest
  endpoint: https://api.example.com/coupons
  method: POST

  input:
    schema:
      - name: code
        type: string
        required: true
        description: Coupon code
      - name: discount_percent
        type: number
        required: true
        description: Discount percentage (0-100)
      - name: expires_at
        type: string
        required: false
        description: Expiry date ISO 8601

    mapping:
      - from: code
        to: coupon_code
        location: body

      - from: discount_percent
        to: discount.percentage
        location: body
        type: float

      - from: expires_at
        to: expiry_date
        location: body

      - static: "percent"
        to: discount.type
        location: body

  output:
    mapping:
      - from: coupon_id
        to: id
        location: body
      - from: coupon_code
        to: code
        location: body
      - from: created_at
        to: created_at
        location: body
```

**MCP call:**
```json
{ "code": "SAVE20", "discount_percent": 20, "expires_at": "2025-12-31T00:00:00Z" }
```

**Upstream request body:**
```json
{
  "coupon_code": "SAVE20",
  "discount": {
    "type": "percent",
    "percentage": 20.0
  },
  "expiry_date": "2025-12-31T00:00:00Z"
}
```

Note: dot-notation in `to` (`discount.percentage`) creates nested objects automatically.

---

### Example 3: XML-RPC — positional parameters

**Tool:** `get_product_stock`  
**Upstream:** XML-RPC method `inventory.getStock(productId: int, warehouseCode: string)`

```yaml
- name: get_product_stock
  description: Check stock level for a product in a warehouse
  protocol: xmlrpc
  endpoint: https://erp.example.com/RPC2
  xmlrpc_method: inventory.getStock

  input:
    schema:
      - name: product_id
        type: integer
        required: true
        description: Numeric product ID
      - name: warehouse
        type: string
        required: true
        description: Warehouse location code

    mapping:
      - from: product_id
        to: param
        location: param
        index: 0
        type: int

      - from: warehouse
        to: param
        location: param
        index: 1
        type: string

  output:
    mapping:
      - from: quantity
        to: stock_level
        location: body
      - from: last_updated
        to: updated_at
        location: body
```

**MCP call:**
```json
{ "product_id": 4821, "warehouse": "EU-NL" }
```

**XML-RPC request:**
```xml
<?xml version="1.0"?>
<methodCall>
  <methodName>inventory.getStock</methodName>
  <params>
    <param><value><int>4821</int></value></param>
    <param><value><string>EU-NL</string></value></param>
  </params>
</methodCall>
```

**XML-RPC response:**
```xml
<methodResponse>
  <params>
    <param>
      <value>
        <struct>
          <member><name>quantity</name><value><int>142</int></value></member>
          <member><name>last_updated</name><value><string>2025-02-20T10:00:00Z</string></value></member>
        </struct>
      </value>
    </param>
  </params>
</methodResponse>
```

**MCP response:**
```json
{ "stock_level": 142, "updated_at": "2025-02-20T10:00:00Z" }
```

---

### Example 4: XML-RPC — struct parameter

**Tool:** `update_contact`  
**Upstream:** XML-RPC method `crm.updateContact(data: struct)`

```yaml
- name: update_contact
  description: Update a CRM contact record
  protocol: xmlrpc
  endpoint: https://crm.example.com/api
  xmlrpc_method: crm.updateContact

  input:
    schema:
      - name: contact_id
        type: string
        required: true
        description: CRM contact ID
      - name: email
        type: string
        required: false
        description: New email address
      - name: phone
        type: string
        required: false
        description: New phone number

    mapping:
      - from: contact_id
        to: id
        location: struct
        index: 0

      - from: email
        to: email_address
        location: struct
        index: 0

      - from: phone
        to: phone_number
        location: struct
        index: 0

  output:
    mapping:
      - from: success
        to: updated
        location: body
      - from: message
        to: message
        location: body
```

**MCP call:**
```json
{ "contact_id": "C-9912", "email": "new@example.com" }
```

**XML-RPC request:**
```xml
<methodCall>
  <methodName>crm.updateContact</methodName>
  <params>
    <param>
      <value>
        <struct>
          <member><name>id</name><value><string>C-9912</string></value></member>
          <member><name>email_address</name><value><string>new@example.com</string></value></member>
        </struct>
      </value>
    </param>
  </params>
</methodCall>
```

Note: `phone` was not provided and has no default, so it is omitted from the struct.

---

## Built-in Transforms

Specified via `transform:` in a mapping field.

| Transform | Description | Example input → output |
|---|---|---|
| `uppercase` | String to uppercase | `"hello"` → `"HELLO"` |
| `lowercase` | String to lowercase | `"HELLO"` → `"hello"` |
| `to_string` | Coerce to string | `123` → `"123"` |
| `to_int` | Coerce to integer | `"42"` → `42` |
| `to_float` | Coerce to float | `"3.14"` → `3.14` |
| `to_boolean` | Coerce to boolean | `"true"` / `1` → `true` |
| `iso_to_unix` | ISO 8601 date to Unix timestamp | `"2025-01-01T00:00:00Z"` → `1735689600` |
| `unix_to_iso` | Unix timestamp to ISO 8601 | `1735689600` → `"2025-01-01T00:00:00Z"` |
| `base64_encode` | Encode string to Base64 | `"hello"` → `"aGVsbG8="` |
| `base64_decode` | Decode Base64 to string | `"aGVsbG8="` → `"hello"` |
| `json_stringify` | Serialize object to JSON string | `{a:1}` → `"{\"a\":1}"` |
| `json_parse` | Deserialize JSON string to object | `"{\"a\":1}"` → `{a:1}` |

---

## Error Handling

All errors are returned as MCP tool errors with a structured payload:

```json
{
  "error": true,
  "code": "UPSTREAM_ERROR",
  "message": "Upstream returned 404",
  "upstream_status": 404,
  "upstream_body": { ... }
}
```

Error codes:

| Code | Trigger |
|---|---|
| `CONFIG_INVALID` | Config fails schema validation at bootstrap |
| `MAPPING_ERROR` | Required parameter missing and no default |
| `UPSTREAM_ERROR` | Upstream returned non-2xx HTTP status |
| `XMLRPC_FAULT` | XML-RPC faultCode returned |
| `TIMEOUT` | Request exceeded `timeout_ms` |
| `TRANSFORM_ERROR` | Type coercion or transform failed |

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `MCP_CONFIG_PATH` | Path to config YAML | No (default: `./config/tools.yaml`) |
| `MCP_SERVER_NAME` | Override server name | No |
| `PORT` | Local dev port | No (default: `3000`) |
| Any referenced in auth `value` fields | Injected into config at bootstrap | Yes if used |

---

## TypeScript Core Types

```typescript
// types.ts

export type Protocol = 'rest' | 'xmlrpc';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export type MappingLocation = 'path' | 'query' | 'body' | 'header' | 'param' | 'struct';
export type AuthType = 'apikey' | 'basic' | 'none';

export interface AuthConfig {
  type: AuthType;
  header?: string;
  value?: string;
  username?: string;
  password?: string;
}

export interface ParameterSchema {
  name: string;
  type: ParamType;
  required: boolean;
  description: string;
  default?: unknown;
}

export interface MappingField {
  from?: string;
  to: string;
  location: MappingLocation;
  type?: string;
  transform?: string;
  default?: unknown;
  index?: number;
  static?: unknown;
}

export interface MappingDefinition {
  mapping: MappingField[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  protocol: Protocol;
  endpoint: string;
  method?: HttpMethod;
  xmlrpc_method?: string;
  timeout_ms?: number;
  auth?: AuthConfig;
  headers?: Record<string, string>;
  input: {
    schema: ParameterSchema[];
    mapping: MappingField[];
  };
  output: {
    mapping: MappingField[];
  };
}

export interface ServerConfig {
  version: string;
  server: {
    name: string;
    description: string;
  };
  defaults?: {
    timeout_ms?: number;
    auth?: AuthConfig;
    headers?: Record<string, string>;
  };
  tools: ToolDefinition[];
}
```

---

## Bootstrap Flow

```
Lambda cold start
  │
  ├─ Load config YAML (from MCP_CONFIG_PATH or default)
  ├─ Validate against JSON Schema → throw CONFIG_INVALID if invalid
  ├─ Resolve env vars in auth values
  ├─ For each tool:
  │    └─ Register MCP tool with generated JSON Schema from input.schema
  │
  └─ MCP Server ready

Incoming tool call
  │
  ├─ Receive MCP arguments
  ├─ Run inbound transform (input.mapping)
  ├─ Route to REST or XML-RPC handler
  ├─ Execute HTTP call
  ├─ Run outbound transform (output.mapping)
  └─ Return MCP response
```

---

## Out of Scope (v1)

- Response streaming
- Request chaining (tool A output → tool B input)
- Conditional mapping logic
- Retry logic (Lambda retries handle this at infra level)
- Custom transform functions (only built-ins)
- GraphQL protocol
