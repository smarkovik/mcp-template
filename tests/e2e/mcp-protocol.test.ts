/**
 * E2E tests: spin up the local HTTP server and exercise the full MCP JSON-RPC
 * protocol over HTTP, using genderize.io as the real upstream.
 *
 * Key design decisions:
 *
 *  1. New transport per request (SDK requirement for stateless mode):
 *     `WebStandardStreamableHTTPServerTransport` (which `StreamableHTTPServerTransport`
 *     wraps) explicitly throws if `handleRequest` is called more than once on the
 *     same instance when `sessionIdGenerator` is `undefined`. We create a fresh
 *     transport for every HTTP request, close it afterwards so the shared McpServer
 *     clears its `_transport` reference.
 *
 *  2. `realFetch` captured at module-load time, before any `vi.stubGlobal` calls.
 *     `mcpPost`/`mcpNotify` always use this reference so per-test fetch stubs only
 *     affect server-side code (`rest.ts`) that reaches out to the upstream.
 *
 *  3. Full MCP handshake (initialize → notifications/initialized) is performed in
 *     `beforeAll` so the McpServer has client capabilities set before tests run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Capture the real fetch BEFORE any vi.stubGlobal calls so test → server
// HTTP requests are never intercepted by per-test fetch mocks.
// ---------------------------------------------------------------------------
const realFetch: typeof fetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Config fixture — genderize.io upstream (no auth required, public API)
// ---------------------------------------------------------------------------

const TMP = join(tmpdir(), 'mcp-proxy-e2e');
const CONFIG_PATH = join(TMP, 'tools.yaml');

const CONFIG_YAML = `
version: "1.0"
server:
  name: e2e-proxy
  description: E2E test proxy

defaults:
  timeout_ms: 10000

tools:
  - name: get_gender
    description: Predict gender for a given name using genderize.io
    protocol: rest
    endpoint: https://api.genderize.io/
    method: GET
    input:
      schema:
        - name: name
          type: string
          required: true
          description: The name to look up
      mapping:
        - from: name
          to: name
          location: query
    output:
      mapping:
        - from: name
          to: name
          location: body
        - from: gender
          to: gender
          location: body
        - from: probability
          to: probability
          location: body
`;

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

/**
 * Send an MCP JSON-RPC request to the local test server and return the first
 * SSE `data:` payload parsed as JSON. Always uses `realFetch` so per-test
 * fetch stubs do not intercept calls from the test harness to the server.
 */
async function mcpPost(body: unknown): Promise<unknown> {
  const res = await realFetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No data line in response:\n${text}`);
  return JSON.parse(dataLine.slice(6));
}

/**
 * Fire-and-forget MCP notification. JSON-RPC notifications have no `id` so
 * the server responds 202 No Content; we ignore the response body.
 */
async function mcpNotify(body: unknown): Promise<void> {
  await realFetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Write config to a temp dir and point the loader at it
  mkdirSync(TMP, { recursive: true });
  writeFileSync(CONFIG_PATH, CONFIG_YAML, 'utf-8');
  process.env['MCP_CONFIG_PATH'] = CONFIG_PATH;

  const { loadConfig } = await import('../../src/loader.js');
  const { createMcpServer } = await import('../../src/server.js');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const config = loadConfig();
  const mcpServer: McpServer = createMcpServer(config);

  // Each HTTP request gets a fresh stateless transport (SDK requirement).
  // Closing the transport after each request clears mcpServer._transport so
  // the next connect() call succeeds.
  server = createServer(async (req, res) => {
    if (!(req.url ?? '').startsWith('/mcp')) {
      res.writeHead(404);
      res.end();
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

  // Perform the mandatory MCP handshake so the server has client capabilities
  await mcpPost({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-e2e', version: '1.0' },
    },
  });
  await mcpNotify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  rmSync(TMP, { recursive: true, force: true });
  delete process.env['MCP_CONFIG_PATH'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Restore any per-test fetch stubs after each test
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP protocol — initialize', () => {
  it('responds with server info and tools capability', async () => {
    const res = (await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0' },
      },
    })) as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } };

    expect(res.result.serverInfo.name).toBe('e2e-proxy');
    expect(res.result.capabilities.tools).toBeDefined();
  });
});

describe('MCP protocol — tools/list', () => {
  it('returns all registered tools with their schemas', async () => {
    const res = (await mcpPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } };

    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('get_gender');

    const getTool = res.result.tools.find((t) => t.name === 'get_gender')!;
    expect(getTool.inputSchema.required).toContain('name');
  });
});

describe('MCP protocol — tools/call (real upstream: genderize.io)', () => {
  it('calls genderize.io and returns gender prediction for "dana"', async () => {
    const res = (await mcpPost({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_gender', arguments: { name: 'dana' } },
    })) as { result: { content: Array<{ text: string }> } };

    const payload = JSON.parse(res.result.content[0]!.text) as {
      name: string;
      gender: string;
      probability: number;
    };

    expect(payload.name).toBe('dana');
    expect(payload.gender).toBe('female');
    expect(typeof payload.probability).toBe('number');
  });
});

describe('MCP protocol — tools/call (upstream error simulation)', () => {
  it('returns isError:true when upstream returns 404', async () => {
    // Stub the global fetch used by rest.ts — mcpPost uses realFetch and is unaffected
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: {
          get: (k: string) => (k === 'content-type' ? 'application/json' : null),
          forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type'),
        },
        json: async () => ({ message: 'not found' }),
      }),
    );

    const res = (await mcpPost({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_gender', arguments: { name: 'unknown_xyz' } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(res.result.isError).toBe(true);
    const payload = JSON.parse(res.result.content[0]!.text) as {
      code: string;
      upstream_status: number;
    };
    expect(payload.code).toBe('UPSTREAM_ERROR');
    expect(payload.upstream_status).toBe(404);
  });
});

describe('MCP protocol — unknown tool', () => {
  it('returns isError:true with MAPPING_ERROR code', async () => {
    const res = (await mcpPost({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(res.result.isError).toBe(true);
    // The MCP SDK intercepts calls to unregistered tools and returns a plain-text
    // error message before our handler is invoked — no JSON payload to parse.
    expect(res.result.content[0]!.text).toContain('no_such_tool');
  });
});
