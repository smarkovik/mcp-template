import type { ServerConfig, ToolDefinition, McpErrorPayload } from './types.js';
import { applyInboundMapping } from './transform/inbound.js';
import { applyOutboundMapping } from './transform/outbound.js';
import { callRest } from './protocols/rest.js';
import { callXmlRpc } from './protocols/xmlrpc.js';

const DEFAULT_TIMEOUT_MS = 5000;

function makeError(
  code: string,
  message: string,
  extras: Partial<McpErrorPayload> = {}
): McpErrorPayload {
  return { error: true, code, message, ...extras };
}

function extractError(err: unknown): McpErrorPayload {
  if (err instanceof Error) {
    const e = err as Error & {
      code?: string;
      upstream_status?: number;
      upstream_body?: unknown;
    };
    return makeError(
      e.code ?? 'UPSTREAM_ERROR',
      e.message,
      {
        upstream_status: e.upstream_status,
        upstream_body: e.upstream_body,
      }
    );
  }
  return makeError('UPSTREAM_ERROR', String(err));
}

export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  config: ServerConfig
): Promise<Record<string, unknown>> {
  const tool: ToolDefinition | undefined = config.tools.find((t) => t.name === toolName);
  if (!tool) {
    return makeError('MAPPING_ERROR', `Unknown tool: ${toolName}`);
  }

  const timeoutMs = tool.timeout_ms ?? config.defaults?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const defaultHeaders = config.defaults?.headers ?? {};
  const defaultAuth = config.defaults?.auth;

  let inbound: ReturnType<typeof applyInboundMapping>;
  try {
    inbound = applyInboundMapping(args, tool, defaultHeaders, defaultAuth);
  } catch (err) {
    return extractError(err);
  }

  try {
    let response: { body: Record<string, unknown>; headers: Record<string, string> };

    if (tool.protocol === 'rest') {
      response = await callRest(inbound, tool, timeoutMs);
    } else {
      response = await callXmlRpc(inbound, tool, timeoutMs);
    }

    return applyOutboundMapping(response.body, response.headers, tool.output.mapping);
  } catch (err) {
    return extractError(err);
  }
}
