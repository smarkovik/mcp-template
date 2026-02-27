/**
 * E2E tests against real public APIs — no auth, no mocking.
 *
 * APIs used:
 *  - GET  https://api.open-meteo.com/v1/forecast   (weather data, free, no key)
 *  - POST https://jsonplaceholder.typicode.com/posts (fake REST API, always 201)
 *
 * These tests perform real network calls. They are intentionally marked with
 * a generous timeout (15 s) to accommodate slow connections in CI.
 *
 * Server setup follows the same pattern as mcp-protocol.test.ts:
 *  - Config written to a temp file, loaded via MCP_CONFIG_PATH
 *  - Fresh StreamableHTTPServerTransport per request (SDK stateless requirement)
 *  - realFetch captured at module load so per-test stubs never affect the harness
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Capture real fetch before any potential vi.stubGlobal calls
const realFetch: typeof fetch = globalThis.fetch;

// ────────────────────────────────────────────────────────────────────────────
// Config fixture — two real public APIs
// ────────────────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), 'mcp-proxy-real-apis-e2e');
const CONFIG_PATH = join(TMP, 'tools.yaml');

const CONFIG_YAML = `
version: "1.0"
server:
  name: real-apis-e2e
  description: E2E test proxy for real public APIs

defaults:
  timeout_ms: 15000

tools:
  # ── GET: open-meteo.com ───────────────────────────────────────────────────
  - name: get_weather
    description: Get current weather for a lat/lon via open-meteo.com (free, no auth)
    protocol: rest
    endpoint: https://api.open-meteo.com/v1/forecast
    method: GET
    input:
      schema:
        - name: latitude
          type: number
          required: true
          description: Latitude coordinate (e.g. 43.70 for Nice, France)
        - name: longitude
          type: number
          required: true
          description: Longitude coordinate (e.g. 7.26 for Nice, France)
      mapping:
        - from: latitude
          to: latitude
          location: query
        - from: longitude
          to: longitude
          location: query
        - static: "true"
          to: current_weather
          location: query
    output:
      mapping:
        - from: current_weather.temperature
          to: temperature
          location: body
        - from: current_weather.windspeed
          to: windspeed
          location: body
        - from: current_weather.weathercode
          to: weathercode
          location: body
        - from: current_weather.is_day
          to: is_day
          location: body

  # ── POST: jsonplaceholder.typicode.com ────────────────────────────────────
  - name: create_post
    description: Create a new post on JSONPlaceholder (fake test API, always returns 201)
    protocol: rest
    endpoint: https://jsonplaceholder.typicode.com/posts
    method: POST
    input:
      schema:
        - name: title
          type: string
          required: true
          description: Post title
        - name: body
          type: string
          required: true
          description: Post body content
        - name: user_id
          type: integer
          required: true
          description: Author user ID
      mapping:
        - from: title
          to: title
          location: body
        - from: body
          to: body
          location: body
        - from: user_id
          to: userId
          location: body
    output:
      mapping:
        - from: id
          to: id
          location: body
        - from: title
          to: title
          location: body
        - from: body
          to: body
          location: body
        - from: userId
          to: userId
          location: body
`;

// ────────────────────────────────────────────────────────────────────────────
// Server lifecycle
// ────────────────────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

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

  // MCP handshake
  await mcpPost({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-real-apis', version: '1.0' },
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
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('real API — GET open-meteo.com (weather)', () => {
  it(
    'returns current weather data for Nice, France (lat 43.70, lon 7.26)',
    async () => {
      const res = (await mcpPost({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'get_weather',
          arguments: { latitude: 43.70, longitude: 7.26 },
        },
      })) as { result: { content: Array<{ text: string }>; isError?: boolean } };

      expect(res.result.isError).toBeFalsy();

      const payload = JSON.parse(res.result.content[0]!.text) as {
        temperature: number;
        windspeed: number;
        weathercode: number;
        is_day: number;
      };

      // Temperature should be a reasonable number (not NaN, not undefined)
      expect(typeof payload.temperature).toBe('number');
      expect(Number.isFinite(payload.temperature)).toBe(true);

      // Windspeed is non-negative
      expect(typeof payload.windspeed).toBe('number');
      expect(payload.windspeed).toBeGreaterThanOrEqual(0);

      // WMO weather code is an integer 0–99
      expect(typeof payload.weathercode).toBe('number');
      expect(payload.weathercode).toBeGreaterThanOrEqual(0);
      expect(payload.weathercode).toBeLessThanOrEqual(99);

      // is_day is 0 or 1
      expect([0, 1]).toContain(payload.is_day);
    },
    15_000, // generous timeout for real network call
  );
});

describe('real API — POST jsonplaceholder.typicode.com (create post)', () => {
  it(
    'creates a post and returns the echoed payload with an assigned id',
    async () => {
      const res = (await mcpPost({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'create_post',
          arguments: {
            title: 'My First API Post',
            body: 'This is a test post using a keyless API.',
            user_id: 1,
          },
        },
      })) as { result: { content: Array<{ text: string }>; isError?: boolean } };

      expect(res.result.isError).toBeFalsy();

      const payload = JSON.parse(res.result.content[0]!.text) as {
        id: number;
        title: string;
        body: string;
        userId: number;
      };

      // JSONPlaceholder always assigns id 101 for new posts
      expect(payload.id).toBe(101);
      expect(payload.title).toBe('My First API Post');
      expect(payload.body).toBe('This is a test post using a keyless API.');
      expect(payload.userId).toBe(1);
    },
    15_000,
  );
});
