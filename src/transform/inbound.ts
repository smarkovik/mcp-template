import type { MappingField, ToolDefinition } from '../types.js';
import { applyTransform, coerceType } from './transforms.js';

/** Set a value at a dot-notation path inside an object, creating intermediate objects as needed. */
function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (cursor[key] === undefined || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export interface InboundResult {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  // XML-RPC only
  xmlrpcParams?: unknown[];
}

export function applyInboundMapping(
  args: Record<string, unknown>,
  tool: ToolDefinition,
  defaultHeaders: Record<string, string> = {},
  defaultAuth?: ToolDefinition['auth']
): InboundResult {
  const mapping: MappingField[] = tool.input.mapping;

  let url = tool.endpoint;
  const queryParams: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = { ...defaultHeaders, ...(tool.headers ?? {}) };
  // XML-RPC: map from index → value
  const xmlrpcPositional: Map<number, unknown> = new Map();
  // XML-RPC: map from index → struct fields
  const xmlrpcStructs: Map<number, Record<string, unknown>> = new Map();

  const auth = tool.auth ?? defaultAuth;
  if (auth) {
    switch (auth.type) {
      case 'apikey':
        if (auth.header && auth.value) headers[auth.header] = auth.value;
        break;
      case 'basic':
        if (auth.username && auth.password) {
          const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;
      case 'none':
        break;
    }
  }

  for (const field of mapping) {
    // Resolve raw value
    let value: unknown;
    if ('static' in field && field.static !== undefined) {
      value = field.static;
    } else {
      const key = field.from!;
      value = args[key] ?? field.default;
      if (value === undefined || value === null) {
        continue; // field not provided and no default — silently omit (required validation is Zod's job)
      }
    }

    // Apply type coercion
    if (field.type) value = coerceType(value, field.type);
    // Apply transform
    if (field.transform) value = applyTransform(value, field.transform);

    // Place value at destination
    switch (field.location) {
      case 'path':
        url = url.replace(`{${field.to}}`, encodeURIComponent(String(value)));
        break;
      case 'query':
        queryParams[field.to] = String(value);
        break;
      case 'body':
        setDeep(body, field.to, value);
        break;
      case 'header':
        headers[field.to] = String(value);
        break;
      case 'param': {
        const idx = field.index ?? 0;
        xmlrpcPositional.set(idx, value);
        break;
      }
      case 'struct': {
        const idx = field.index ?? 0;
        if (!xmlrpcStructs.has(idx)) xmlrpcStructs.set(idx, {});
        setDeep(xmlrpcStructs.get(idx)!, field.to, value);
        break;
      }
    }
  }

  // Append query string
  const qs = new URLSearchParams(queryParams).toString();
  if (qs) url += `?${qs}`;

  // Build XML-RPC params array (positional entries win; structs are placed at their index)
  let xmlrpcParams: unknown[] | undefined;
  if (tool.protocol === 'xmlrpc') {
    const allIndexes = new Set([...xmlrpcPositional.keys(), ...xmlrpcStructs.keys()]);
    if (allIndexes.size > 0) {
      const maxIdx = Math.max(...allIndexes);
      xmlrpcParams = Array.from({ length: maxIdx + 1 }, (_, i) => {
        if (xmlrpcPositional.has(i)) return xmlrpcPositional.get(i);
        if (xmlrpcStructs.has(i)) return xmlrpcStructs.get(i);
        return null;
      });
    } else {
      xmlrpcParams = [];
    }
  }

  return {
    url,
    method: tool.method ?? 'POST',
    headers,
    body: Object.keys(body).length > 0 ? body : undefined,
    xmlrpcParams,
  };
}
