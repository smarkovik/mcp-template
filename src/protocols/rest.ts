import type { InboundResult } from '../transform/inbound.js';
import type { ToolDefinition } from '../types.js';

export interface RestResponse {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  status: number;
}

export async function callRest(
  inbound: InboundResult,
  tool: ToolDefinition,
  timeoutMs: number
): Promise<RestResponse> {
  const headers: Record<string, string> = { ...inbound.headers };

  const init: RequestInit = {
    method: inbound.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (inbound.body !== undefined && inbound.method !== 'GET' && inbound.method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(inbound.body);
  }

  let response: Response;
  try {
    response = await fetch(inbound.url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw Object.assign(new Error(`TIMEOUT: Request to ${tool.endpoint} timed out after ${timeoutMs}ms`), {
        code: 'TIMEOUT',
      });
    }
    throw Object.assign(new Error(`UPSTREAM_ERROR: ${err instanceof Error ? err.message : String(err)}`), {
      code: 'UPSTREAM_ERROR',
    });
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });

  let body: Record<string, unknown> = {};
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else {
    const text = await response.text();
    if (text) body = { _raw: text };
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(`UPSTREAM_ERROR: Upstream returned ${response.status}`),
      {
        code: 'UPSTREAM_ERROR',
        upstream_status: response.status,
        upstream_body: body,
      }
    );
  }

  return { body, headers: responseHeaders, status: response.status };
}
