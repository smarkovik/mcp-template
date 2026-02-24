import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './loader.js';
import { createMcpServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const config = loadConfig();
const mcpServer = createMcpServer(config);

console.log(`[mcp-proxy] Loaded ${config.tools.length} tool(s): ${config.tools.map((t) => t.name).join(', ')}`);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});

await mcpServer.connect(transport);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Only serve /mcp
  const url = req.url ?? '/';
  if (!url.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Use /mcp');
    return;
  }

  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`[mcp-proxy] Local server running → http://localhost:${PORT}/mcp`);
  console.log(`[mcp-proxy] Server: ${config.server.name}`);
});
