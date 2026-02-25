import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeToolCall } from '../../src/router.js';
import type { ServerConfig } from '../../src/types.js';

// Minimal config used across tests
const config: ServerConfig = {
  version: '1.0',
  server: { name: 'test', description: 'test' },
  tools: [
    {
      name: 'get_item',
      description: 'Get an item',
      protocol: 'rest',
      endpoint: 'https://api.example.com/items/{item_id}',
      method: 'GET',
      input: {
        schema: [{ name: 'item_id', type: 'string', required: true, description: 'ID' }],
        mapping: [{ from: 'item_id', to: 'item_id', location: 'path' }],
      },
      output: {
        mapping: [
          { from: 'id', to: 'item_id', location: 'body' },
          { from: 'name', to: 'name', location: 'body' },
        ],
      },
    },
    {
      name: 'create_item',
      description: 'Create an item',
      protocol: 'rest',
      endpoint: 'https://api.example.com/items',
      method: 'POST',
      input: {
        schema: [{ name: 'name', type: 'string', required: true, description: 'Name' }],
        mapping: [{ from: 'name', to: 'name', location: 'body' }],
      },
      output: {
        mapping: [{ from: 'id', to: 'id', location: 'body' }],
      },
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('routeToolCall', () => {
  it('returns MAPPING_ERROR for unknown tool', async () => {
    const result = await routeToolCall('no_such_tool', {}, config);
    expect(result['error']).toBe(true);
    expect(result['code']).toBe('MAPPING_ERROR');
  });

  it('calls REST endpoint and applies outbound mapping', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k === 'content-type' ? 'application/json' : null),
        forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type'),
      },
      json: async () => ({ id: 'I-1', name: 'Widget' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await routeToolCall('get_item', { item_id: 'I-1' }, config);
    expect(result).toEqual({ item_id: 'I-1', name: 'Widget' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.example.com/items/I-1');
  });

  it('returns UPSTREAM_ERROR when upstream returns non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: {
        get: () => 'application/json',
        forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type'),
      },
      json: async () => ({ message: 'not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await routeToolCall('get_item', { item_id: 'MISSING' }, config);
    expect(result['error']).toBe(true);
    expect(result['code']).toBe('UPSTREAM_ERROR');
    expect(result['upstream_status']).toBe(404);
  });

  it('returns TIMEOUT error when fetch times out', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    const result = await routeToolCall('get_item', { item_id: 'I-1' }, config);
    expect(result['error']).toBe(true);
    expect(result['code']).toBe('TIMEOUT');
  });

  it('sends JSON body for POST tool', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: {
        get: (k: string) => (k === 'content-type' ? 'application/json' : null),
        forEach: (fn: (v: string, k: string) => void) => fn('application/json', 'content-type'),
      },
      json: async () => ({ id: 'I-99' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await routeToolCall('create_item', { name: 'Gadget' }, config);
    expect(result).toEqual({ id: 'I-99' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Gadget' });
  });

  it('uses per-tool timeout_ms', async () => {
    const configWithTimeout: ServerConfig = {
      ...config,
      tools: [{ ...config.tools[0]!, timeout_ms: 1 }],
    };
    const timeoutError = Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    const result = await routeToolCall('get_item', { item_id: 'X' }, configWithTimeout);
    expect(result['code']).toBe('TIMEOUT');
  });
});
