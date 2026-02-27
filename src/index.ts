import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { loadConfig } from './loader.js';
import { createMcpServer } from './server.js';
import { verifyProxyApiKey } from './auth.js';

// Load config and build server once at cold start (reused across warm invocations)
const config = loadConfig();
const mcpServer = createMcpServer(config);

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context
): Promise<APIGatewayProxyResultV2> {
  // ── Proxy-level API key authentication ─────────────────────────────────────
  // Checks the Authorization or X-Api-Key header against PROXY_API_KEY.
  // If PROXY_API_KEY is not set, all requests are allowed (auth disabled).
  if (!verifyProxyApiKey(
    event.headers?.['authorization'],
    event.headers?.['x-api-key'],
  )) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: true,
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing API key. Provide it via "Authorization: Bearer <key>" or "X-Api-Key: <key>".',
      }),
    };
  }

  // Create a fresh stateless transport per invocation (Lambda is effectively stateless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);

  const method = event.requestContext.http.method.toUpperCase();
  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body
    : undefined;

  // Build a Web Standard Request from the API Gateway event
  const url = `https://lambda${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) {
    if (v !== undefined) headers.set(k, v);
  }

  const request = new Request(url, {
    method,
    headers,
    body: rawBody,
  });

  const response = await transport.handleRequest(request);

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => { responseHeaders[k] = v; });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: await response.text(),
  };
}
