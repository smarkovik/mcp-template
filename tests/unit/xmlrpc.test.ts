import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callXmlRpc } from '../../src/protocols/xmlrpc.js';
import type { InboundResult } from '../../src/transform/inbound.js';
import type { ToolDefinition } from '../../src/types.js';

const tool: ToolDefinition = {
  name: 'get_stock',
  description: 'Get stock',
  protocol: 'xmlrpc',
  endpoint: 'https://erp.example.com/RPC2',
  xmlrpc_method: 'inventory.getStock',
  input: { schema: [], mapping: [] },
  output: { mapping: [] },
};

const inbound: InboundResult = {
  url: 'https://erp.example.com/RPC2',
  method: 'POST',
  headers: {},
  body: undefined,
  xmlrpcParams: [4821, 'EU-NL'],
};

function mockXmlRpcResponse(xml: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      forEach: (fn: (v: string, k: string) => void) => fn('text/xml', 'content-type'),
    },
    text: async () => xml,
  });
}

beforeEach(() => vi.restoreAllMocks());

describe('callXmlRpc', () => {
  it('sends a well-formed XML-RPC methodCall', async () => {
    const fetchMock = mockXmlRpcResponse(`
      <methodResponse><params><param><value>
        <struct>
          <member><name>quantity</name><value><int>142</int></value></member>
          <member><name>last_updated</name><value><string>2025-01-01</string></value></member>
        </struct>
      </value></param></params></methodResponse>
    `);
    vi.stubGlobal('fetch', fetchMock);

    await callXmlRpc(inbound, tool, 5000);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    expect(body).toContain('<methodName>inventory.getStock</methodName>');
    expect(body).toContain('<int>4821</int>');
    expect(body).toContain('<string>EU-NL</string>');
  });

  it('parses struct response into a plain object', async () => {
    vi.stubGlobal('fetch', mockXmlRpcResponse(`
      <methodResponse><params><param><value>
        <struct>
          <member><name>quantity</name><value><int>99</int></value></member>
          <member><name>sku</name><value><string>SKU-1</string></value></member>
        </struct>
      </value></param></params></methodResponse>
    `));

    const result = await callXmlRpc(inbound, tool, 5000);
    expect(result.body).toMatchObject({ quantity: 99, sku: 'SKU-1' });
  });

  it('throws XMLRPC_FAULT on fault response', async () => {
    vi.stubGlobal('fetch', mockXmlRpcResponse(`
      <methodResponse><fault><value>
        <struct>
          <member><name>faultCode</name><value><int>404</int></value></member>
          <member><name>faultString</name><value><string>Not found</string></value></member>
        </struct>
      </value></fault></methodResponse>
    `));

    await expect(callXmlRpc(inbound, tool, 5000)).rejects.toThrow('XMLRPC_FAULT');
  });

  it('throws UPSTREAM_ERROR on non-2xx HTTP status', async () => {
    vi.stubGlobal('fetch', mockXmlRpcResponse('Internal Server Error', 500));
    await expect(callXmlRpc(inbound, tool, 5000)).rejects.toThrow('UPSTREAM_ERROR');
  });

  it('throws TIMEOUT on AbortSignal timeout', async () => {
    const err = Object.assign(new Error('Aborted'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    await expect(callXmlRpc(inbound, tool, 1)).rejects.toThrow('TIMEOUT');
  });

  it('sets Content-Type: text/xml on the request', async () => {
    vi.stubGlobal('fetch', mockXmlRpcResponse(`
      <methodResponse><params><param><value><string>ok</string></value></param></params></methodResponse>
    `));
    const fetchMock = vi.mocked(global.fetch);

    await callXmlRpc(inbound, tool, 5000).catch(() => {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toContain('text/xml');
  });
});
