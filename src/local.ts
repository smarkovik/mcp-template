import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './loader.js';
import { createMcpServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const config = loadConfig();
const mcpServer = createMcpServer(config);

console.log(`[mcp-proxy] Loaded ${config.tools.length} tool(s): ${config.tools.map((t) => t.name).join(', ')}`);

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
