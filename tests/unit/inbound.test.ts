import { describe, it, expect } from 'vitest';
import { applyInboundMapping } from '../../src/transform/inbound.js';
import type { ToolDefinition } from '../../src/types.js';

// Minimal tool factory
function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'test',
    protocol: 'rest',
    endpoint: 'https://api.example.com/resource',
    method: 'GET',
    input: { schema: [], mapping: [] },
    output: { mapping: [] },
    ...overrides,
  };
}

describe('applyInboundMapping — REST', () => {
  it('substitutes a path variable', () => {
    const tool = makeTool({
      endpoint: 'https://api.example.com/orders/{order_id}',
      input: {
        schema: [],
        mapping: [{ from: 'order_id', to: 'order_id', location: 'path' }],
      },
    });
    const result = applyInboundMapping({ order_id: 'ORD-123' }, tool);
    expect(result.url).toBe('https://api.example.com/orders/ORD-123');
  });

  it('appends query parameters', () => {
    const tool = makeTool({
      input: {
        schema: [],
        mapping: [
          { from: 'page', to: 'page', location: 'query' },
          { from: 'limit', to: 'per_page', location: 'query' },
        ],
      },
    });
    const result = applyInboundMapping({ page: '2', limit: '50' }, tool);
    expect(result.url).toContain('page=2');
    expect(result.url).toContain('per_page=50');
  });

  it('builds a JSON body with dot-notation nesting', () => {
    const tool = makeTool({
      method: 'POST',
      input: {
        schema: [],
        mapping: [
          { from: 'code', to: 'coupon_code', location: 'body' },
          { from: 'pct', to: 'discount.percentage', location: 'body' },
          { static: 'percent', to: 'discount.type', location: 'body' },
        ],
      },
    });
    const result = applyInboundMapping({ code: 'SAVE20', pct: 20 }, tool);
    expect(result.body).toEqual({
      coupon_code: 'SAVE20',
      discount: { percentage: 20, type: 'percent' },
    });
  });

  it('adds a custom header', () => {
    const tool = makeTool({
      input: {
        schema: [],
        mapping: [{ from: 'token', to: 'X-Custom-Token', location: 'header' }],
      },
    });
    const result = applyInboundMapping({ token: 'abc123' }, tool);
    expect(result.headers['X-Custom-Token']).toBe('abc123');
  });

  it('applies type coercion on a field', () => {
    const tool = makeTool({
      input: {
        schema: [],
        mapping: [{ from: 'active', to: 'active', location: 'query', type: 'boolean' }],
      },
    });
    const result = applyInboundMapping({ active: 'true' }, tool);
    expect(result.url).toContain('active=true');
  });

  it('applies a transform on a field', () => {
    const tool = makeTool({
      method: 'POST',
      input: {
        schema: [],
        mapping: [{ from: 'name', to: 'name', location: 'body', transform: 'uppercase' }],
      },
    });
    const result = applyInboundMapping({ name: 'alice' }, tool);
    expect(result.body).toEqual({ name: 'ALICE' });
  });

  it('uses field default when arg is missing', () => {
    const tool = makeTool({
      input: {
        schema: [],
        mapping: [{ from: 'limit', to: 'limit', location: 'query', default: '10' }],
      },
    });
    const result = applyInboundMapping({}, tool);
    expect(result.url).toContain('limit=10');
  });

  it('skips optional field when missing and no default', () => {
    const tool = makeTool({
      input: {
        schema: [],
        mapping: [{ from: 'optional_field', to: 'optional_field', location: 'query' }],
      },
    });
    const result = applyInboundMapping({}, tool);
    expect(result.url).not.toContain('optional_field');
  });

  it('injects apikey auth header', () => {
    const tool = makeTool({
      auth: { type: 'apikey', header: 'Authorization', value: 'Bearer tok123' },
      input: { schema: [], mapping: [] },
    });
    const result = applyInboundMapping({}, tool);
    expect(result.headers['Authorization']).toBe('Bearer tok123');
  });

  it('injects basic auth header', () => {
    const tool = makeTool({
      auth: { type: 'basic', username: 'user', password: 'pass' },
      input: { schema: [], mapping: [] },
    });
    const result = applyInboundMapping({}, tool);
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    expect(result.headers['Authorization']).toBe(expected);
  });

  it('merges default headers then tool headers', () => {
    const tool = makeTool({
      headers: { 'X-Tool': 'tool-value' },
      input: { schema: [], mapping: [] },
    });
    const result = applyInboundMapping({}, tool, { 'X-Default': 'default-value' });
    expect(result.headers['X-Default']).toBe('default-value');
    expect(result.headers['X-Tool']).toBe('tool-value');
  });
});

describe('applyInboundMapping — XML-RPC', () => {
  it('builds positional params', () => {
    const tool = makeTool({
      protocol: 'xmlrpc',
      xmlrpc_method: 'inventory.getStock',
      input: {
        schema: [],
        mapping: [
          { from: 'product_id', to: 'param', location: 'param', index: 0, type: 'int' },
          { from: 'warehouse', to: 'param', location: 'param', index: 1 },
        ],
      },
    });
    const result = applyInboundMapping({ product_id: '42', warehouse: 'EU-NL' }, tool);
    expect(result.xmlrpcParams).toEqual([42, 'EU-NL']);
  });

  it('builds a struct param', () => {
    const tool = makeTool({
      protocol: 'xmlrpc',
      xmlrpc_method: 'crm.updateContact',
      input: {
        schema: [],
        mapping: [
          { from: 'contact_id', to: 'id', location: 'struct', index: 0 },
          { from: 'email', to: 'email_address', location: 'struct', index: 0 },
        ],
      },
    });
    const result = applyInboundMapping({ contact_id: 'C-99', email: 'a@b.com' }, tool);
    expect(result.xmlrpcParams).toEqual([{ id: 'C-99', email_address: 'a@b.com' }]);
  });

  it('omits struct fields that are missing without default', () => {
    const tool = makeTool({
      protocol: 'xmlrpc',
      xmlrpc_method: 'crm.updateContact',
      input: {
        schema: [],
        mapping: [
          { from: 'id', to: 'id', location: 'struct', index: 0 },
          { from: 'phone', to: 'phone', location: 'struct', index: 0 },
        ],
      },
    });
    const result = applyInboundMapping({ id: 'C-1' }, tool);
    expect(result.xmlrpcParams).toEqual([{ id: 'C-1' }]);
  });
});
