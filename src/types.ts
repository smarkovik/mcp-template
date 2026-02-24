export type Protocol = 'rest' | 'xmlrpc';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export type MappingLocation = 'path' | 'query' | 'body' | 'header' | 'param' | 'struct';
export type AuthType = 'apikey' | 'basic' | 'none';
export type BuiltinTransform =
  | 'uppercase'
  | 'lowercase'
  | 'to_string'
  | 'to_int'
  | 'to_float'
  | 'to_boolean'
  | 'iso_to_unix'
  | 'unix_to_iso'
  | 'base64_encode'
  | 'base64_decode'
  | 'json_stringify'
  | 'json_parse';

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
  transform?: BuiltinTransform;
  default?: unknown;
  index?: number;
  static?: unknown;
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

// Runtime types used internally during a tool call
export interface ResolvedToolConfig extends ToolDefinition {
  // auth values already have env vars substituted
}

export interface UpstreamRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
  // XML-RPC only
  xmlrpcMethod?: string;
  xmlrpcParams?: unknown[];
}

export interface McpErrorPayload {
  [key: string]: unknown;
  error: true;
  code: string;
  message: string;
  upstream_status?: number;
  upstream_body?: unknown;
}
