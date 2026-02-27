# Configuration Reference

All tool behaviour is declared in a single YAML file (`config/tools.yaml` by default, overridden via `MCP_CONFIG_PATH`). No code changes are required to add, modify, or remove tools.

---

## Top-level structure

```yaml
version: "1.0"          # Required. Schema version (always "1.0").

server:                  # Required. MCP server identity.
  name: my-proxy         # Required. Shown to MCP clients.
  description: string    # Required. Free-text description.

defaults:                # Optional. Applied to every tool that doesn't override.
  timeout_ms: 5000       # Default request timeout in milliseconds.
  auth:                  # Default upstream auth (see Auth types below).
    type: apikey
    header: Authorization
    value: Bearer ${MY_API_KEY}
  headers:               # Default HTTP headers sent with every request.
    X-Source: mcp-proxy

tools:                   # Required. At least one tool.
  - ...
```

---

## Tool definition

```yaml
tools:
  - name: tool_name          # Required. snake_case, /^[a-z][a-z0-9_]*$/.
    description: string      # Required. Shown to the LLM.
    protocol: rest           # Required. "rest" or "xmlrpc".
    endpoint: https://...    # Required. Target URL. Supports {variable} substitution.
    method: GET              # REST only. GET | POST | PUT | PATCH | DELETE.
    xmlrpc_method: foo.bar   # XML-RPC only. Remote method name.
    timeout_ms: 10000        # Optional. Overrides defaults.timeout_ms.
    auth:                    # Optional. Overrides defaults.auth (see Auth types).
      type: none
    headers:                 # Optional. Merged with defaults.headers (tool wins on conflict).
      X-Tool-Header: value

    input:
      schema:                # Required. Parameters exposed to the LLM.
        - ...                # (see Parameter schema below)
      mapping:               # Required. How parameters map to the upstream request.
        - ...                # (see Mapping field below)

    output:
      mapping:               # Required. How the upstream response maps to the tool result.
        - ...
```

---

## Parameter schema

Each entry in `input.schema` defines one parameter the LLM can pass to the tool.

```yaml
input:
  schema:
    - name: order_id         # Required. Used as the argument name by the LLM.
      type: string           # Required. string | number | integer | boolean | object | array
      required: true         # Required. Whether the LLM must provide this argument.
      description: string    # Required. Shown to the LLM.
      default: "pending"     # Optional. Used when the argument is not provided.
```

### Type mapping

| Config type | Zod schema | Notes |
|---|---|---|
| `string` | `z.string()` | |
| `number` | `z.number()` | Float |
| `integer` | `z.number().int()` | |
| `boolean` | `z.boolean()` | |
| `object` | `z.record(z.unknown())` | |
| `array` | `z.array(z.unknown())` | |

---

## Mapping field

A mapping field describes how one value flows from its source to its destination.

```yaml
mapping:
  - from: field_name         # Source field name (from LLM args or API response).
                             # Omit when using `static`.
    to: target_name          # Destination field name or dot-notation path.
    location: query          # Where to place / read from (see Locations below).
    type: int                # Optional. Type coercion applied before placement.
    transform: uppercase     # Optional. Transform applied after coercion.
    default: "N/A"           # Optional. Used when `from` field is missing/null.
    index: 0                 # XML-RPC only. Positional param index (0-based).
    static: "fixed_value"    # Optional. Ignore `from`; always use this literal value.
```

### Locations

**Inbound (input.mapping — LLM args → upstream request):**

| Location | Effect |
|---|---|
| `path` | Substitutes `{to}` in the endpoint URL (URL-encoded). |
| `query` | Appends `to=value` as a query string parameter. |
| `body` | Sets field in the JSON request body. Supports dot-notation nesting. |
| `header` | Sets an HTTP request header. |
| `param` | XML-RPC only. Positional parameter, ordered by `index`. |
| `struct` | XML-RPC only. Named field in an XML-RPC `<struct>` at position `index`. |

**Outbound (output.mapping — upstream response → tool result):**

| Location | Effect |
|---|---|
| `body` | Reads field from the JSON response body. Supports dot-notation. |
| `header` | Reads an HTTP response header (case-insensitive). |

### Dot-notation nesting (body)

`to: discount.percentage` writes `{ "discount": { "percentage": 20 } }` in the request body.
`from: current_weather.temperature` reads `response.current_weather.temperature` from the response.

### Static values

When `static` is set, the `from` field is ignored and the literal value is always used:

```yaml
- static: "percent"
  to: discount.type
  location: body
```

### Optional vs required fields

- A field is **required** if `required: true` in `input.schema` and has no `default` in the mapping.
- A field that is not provided by the LLM and has no `default` is **silently omitted** from the request (not an error).
- Required-field validation is handled by the Zod schema (the LLM won't call the tool without them).

---

## Auth types

### API Key

```yaml
auth:
  type: apikey
  header: Authorization          # Any header name
  value: Bearer ${MY_API_KEY}    # Supports ${ENV_VAR} interpolation
```

### Basic Auth

```yaml
auth:
  type: basic
  username: ${API_USER}
  password: ${API_PASS}
```

### None

```yaml
auth:
  type: none    # Disables auth for this tool (overrides defaults.auth)
```

---

## Built-in transforms

Applied via `transform:` on any mapping field (input or output).

| Transform | Input | Output | Error |
|---|---|---|---|
| `uppercase` | `"hello"` | `"HELLO"` | — |
| `lowercase` | `"HELLO"` | `"hello"` | — |
| `to_string` | `42` | `"42"` | — |
| `to_int` | `"42.9"` | `42` | Non-numeric string |
| `to_float` | `"3.14"` | `3.14` | Non-numeric string |
| `to_boolean` | `"true"`, `1` | `true` | Unknown string |
| `iso_to_unix` | `"2024-01-01T00:00:00Z"` | `1704067200` | Invalid date |
| `unix_to_iso` | `1704067200` | `"2024-01-01T00:00:00.000Z"` | NaN |
| `base64_encode` | `"hello"` | `"aGVsbG8="` | — |
| `base64_decode` | `"aGVsbG8="` | `"hello"` | — |
| `json_stringify` | `{ "a": 1 }` | `'{"a":1}'` | — |
| `json_parse` | `'{"a":1}'` | `{ "a": 1 }` | Invalid JSON |

---

## Type coercion

Applied via `type:` on any mapping field. Runs before `transform`.

| Coercion | Equivalent transform |
|---|---|
| `int` / `integer` | `to_int` |
| `float` / `number` | `to_float` |
| `boolean` | `to_boolean` |
| `string` | `to_string` |

---

## Environment variable interpolation

Any `${VAR_NAME}` placeholder in `auth.value`, `auth.username`, or `auth.password` is resolved from the process environment at startup. Missing variables cause `CONFIG_INVALID` at boot.

```yaml
auth:
  type: apikey
  header: Authorization
  value: Bearer ${OPENAI_API_KEY}   # must be set in the environment
```

---

## Complete example

```yaml
version: "1.0"

server:
  name: shop-proxy
  description: Wraps the Acme Shop REST API as MCP tools

defaults:
  timeout_ms: 8000
  auth:
    type: apikey
    header: Authorization
    value: Bearer ${ACME_API_KEY}
  headers:
    X-Source: mcp-proxy

tools:
  # ── GET with path variable + query parameter ───────────────────────────────
  - name: get_order
    description: Fetch an order by ID
    protocol: rest
    endpoint: https://api.acme.com/orders/{order_id}
    method: GET
    input:
      schema:
        - name: order_id
          type: string
          required: true
          description: The order ID
        - name: include_items
          type: boolean
          required: false
          default: false
          description: Include line items in the response
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
        - from: total_price
          to: total
          location: body
          type: float

  # ── POST with nested JSON body ─────────────────────────────────────────────
  - name: create_coupon
    description: Create a percentage discount coupon
    protocol: rest
    endpoint: https://api.acme.com/coupons
    method: POST
    auth:
      type: none    # public endpoint — override the default auth
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
      mapping:
        - from: code
          to: coupon_code
          location: body
        - from: discount_percent
          to: discount.percentage
          location: body
          type: float
        - static: "percent"
          to: discount.type
          location: body
    output:
      mapping:
        - from: coupon_id
          to: id
          location: body
        - from: expires_at
          to: expires_unix
          location: body
          transform: iso_to_unix

  # ── XML-RPC with positional params ─────────────────────────────────────────
  - name: get_stock
    description: Check inventory for a product in a warehouse
    protocol: xmlrpc
    endpoint: https://erp.acme.com/RPC2
    xmlrpc_method: inventory.getStock
    input:
      schema:
        - name: product_id
          type: integer
          required: true
          description: Product SKU identifier
        - name: warehouse
          type: string
          required: true
          description: Warehouse code
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
    output:
      mapping:
        - from: quantity
          to: stock_level
          location: body
        - from: last_updated
          to: updated_iso
          location: body
          transform: unix_to_iso
```

---

## Validation errors

The config is validated against a JSON Schema at startup. Common errors:

| Error | Cause |
|---|---|
| `CONFIG_INVALID: must have required property 'name'` | Missing `server.name` or tool `name` |
| `CONFIG_INVALID: must be equal to one of the allowed values` | Invalid `protocol`, `method`, `location`, or `transform` |
| `CONFIG_INVALID: must match pattern "^[a-z][a-z0-9_]*$"` | Tool name contains uppercase or special characters |
| `CONFIG_INVALID: Environment variable "X" is not set` | `${X}` in auth config but `X` is not in the environment |
| `CONFIG_INVALID: Failed to read or parse config` | File not found, bad YAML, or permission denied |
