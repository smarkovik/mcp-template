/**
 * E2E tests for proxy-level API key authentication.
 *
 * Spins up a local MCP HTTP server with PROXY_API_KEY set, then verifies that:
 *  - Requests with no key are rejected with HTTP 401
 *  - Requests with a wrong key are rejected with HTTP 401
 *  - Requests with the correct key via "Authorization: Bearer <key>" succeed
 *  - Requests with the correct key via "X-Api-Key: <key>" succeed
 *  - When PROXY_API_KEY is unset, all requests are allowed through
 *
 * Uses genderize.io (same as mcp-protocol.test.ts) as the upstream so the MCP
 * handshake + tools/list calls have a real tool to work with.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const realFetch: typeof fetch = globalThis.fetch;

// ────────────────────────────────────────────────────────────────────────────
// Config fixture (minimal — just needs one tool to make the server valid)
// ────────────────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), 'mcp-proxy-auth-e2e');
const CONFIG_PATH = join(TMP, 'tools.yaml');

const CONFIG_YAML = `
version: "1.0"
server:
  name: auth-e2e
  description: Proxy auth E2E test server

tools:
  - name: get_gender
    description: Proxy auth test tool (genderize.io)
    protocol: rest
    endpoint: https://api.genderize.io/
    method: GET
    input:
      schema:
        - name: name
          type: string
          required: true
          description: Name to look up
      mapping:
        - from: name
          to: name
          location: query
    output:
      mapping:
        - from: gender
          to: gender
          location: body
`;

// ────────────────────────────────────────────────────────────────────────────
// Server factory — builds an HTTP server with optional PROXY_API_KEY auth
// ────────────────────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-proxy-secret-key-42';

let server: Server;
let baseUrl: string;

/**
 * Raw HTTP helper — does NOT perform MCP handshake, just hits /mcp and
 * returns the raw Response so we can inspect status codes.
 */
async function rawPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return realFetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Authenticated MCP POST — always sends the correct proxy API key.
 */
async function authedMcpPost(body: unknown): Promise<unknown> {
  const res = await rawPost(body, { Authorization: `Bearer ${TEST_API_KEY}` });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No data line in response:\n${text}`);
  return JSON.parse(dataLine.slice(6));
}

async function authedMcpNotify(body: unknown): Promise<void> {
  await rawPost(body, { Authorization: `Bearer ${TEST_API_KEY}` });
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG_PATH, CONFIG_YAML, 'utf-8');
  process.env['MCP_CONFIG_PATH'] = CONFIG_PATH;

  // Enable proxy auth
  process.env['PROXY_API_KEY'] = TEST_API_KEY;

  const { loadConfig } = await import('../../src/loader.js');
  const { createMcpServer } = await import('../../src/server.js');
  const { verifyProxyApiKey } = await import('../../src/auth.js');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const config = loadConfig();
  const mcpServer: McpServer = createMcpServer(config);

  server = createServer(async (req, res) => {
    if (!(req.url ?? '').startsWith('/mcp')) {
      res.writeHead(404);
      res.end();
      return;
    }

    // ── Auth check (mirrors local.ts) ────────────────────────────────────────
    if (!verifyProxyApiKey(
      req.headers['authorization'] as string | undefined,
      req.headers['x-api-key'] as string | undefined,
    )) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: true,
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing API key.',
      }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      await transport.close();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Handshake using the correct key
  await authedMcpPost({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-auth-e2e', version: '1.0' },
    },
  });
  await authedMcpNotify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  rmSync(TMP, { recursive: true, force: true });
  delete process.env['MCP_CONFIG_PATH'];
  delete process.env['PROXY_API_KEY'];
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('proxy authentication — rejected requests', () => {
  it('returns HTTP 401 when no auth header is provided', async () => {
    const res = await rawPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);

    const body = await res.json() as { error: boolean; code: string };
    expect(body.error).toBe(true);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns HTTP 401 when the Authorization Bearer key is wrong', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { Authorization: 'Bearer wrong-key' },
    );
    expect(res.status).toBe(401);
  });

  it('returns HTTP 401 when the X-Api-Key is wrong', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { 'X-Api-Key': 'wrong-key' },
    );
    expect(res.status).toBe(401);
  });
});

describe('proxy authentication — accepted requests', () => {
  it('allows requests with the correct key via "Authorization: Bearer <key>"', async () => {
    const res = (await authedMcpPost({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    })) as { result: { tools: Array<{ name: string }> } };

    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('get_gender');
  });

  it('allows requests with the correct key via "X-Api-Key: <key>"', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      { 'X-Api-Key': TEST_API_KEY },
    );
    expect(res.status).toBe(200);

    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();

    const parsed = JSON.parse(dataLine!.slice(6)) as { result: { tools: Array<{ name: string }> } };
    expect(parsed.result.tools.map((t) => t.name)).toContain('get_gender');
  });
});
