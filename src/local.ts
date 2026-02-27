import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './loader.js';
import { createMcpServer } from './server.js';
import { verifyProxyApiKey, isProxyAuthEnabled } from './auth.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const config = loadConfig();
const mcpServer = createMcpServer(config);

console.log(`[mcp-proxy] Loaded ${config.tools.length} tool(s): ${config.tools.map((t) => t.name).join(', ')}`);

if (isProxyAuthEnabled()) {
  console.log('[mcp-proxy] Proxy API key authentication ENABLED (PROXY_API_KEY is set)');
} else {
  console.log('[mcp-proxy] Warning: Proxy API key auth is DISABLED. Set PROXY_API_KEY to protect this endpoint.');
}

// Each HTTP request gets a fresh stateless transport (SDK requirement: stateless
// transports cannot be reused across requests). The McpServer instance is shared
// so tool registrations are preserved; after each request the transport is closed
// which resets the server's _transport reference for the next connection.
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Only serve /mcp
  const url = req.url ?? '/';
  if (!url.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Use /mcp');
    return;
  }

  // ── Proxy-level API key authentication ─────────────────────────────────────
  // Checks the Authorization or X-Api-Key header against PROXY_API_KEY.
  // If PROXY_API_KEY is not set, all requests are allowed (auth disabled).
  if (!verifyProxyApiKey(
    req.headers['authorization'] as string | undefined,
    req.headers['x-api-key'] as string | undefined,
  )) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing API key. Provide it via "Authorization: Bearer <key>" or "X-Api-Key: <key>".',
    }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await mcpServer.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    // Close the transport so mcpServer._transport is cleared before the next request
    await transport.close();
  }
});

httpServer.listen(PORT, () => {
  console.log(`[mcp-proxy] Local server running → http://localhost:${PORT}/mcp`);
  console.log(`[mcp-proxy] Server: ${config.server.name}`);
});
