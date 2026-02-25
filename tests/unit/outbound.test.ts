import { describe, it, expect } from 'vitest';
import { applyOutboundMapping } from '../../src/transform/outbound.js';
import type { MappingField } from '../../src/types.js';

describe('applyOutboundMapping', () => {
  it('maps flat body fields', () => {
    const body = { id: 'ORD-1', status: 'shipped', total_amount: 99.99 };
    const mapping: MappingField[] = [
      { from: 'id', to: 'order_id', location: 'body' },
      { from: 'status', to: 'status', location: 'body' },
      { from: 'total_amount', to: 'total', location: 'body' },
    ];
    const result = applyOutboundMapping(body, {}, mapping);
    expect(result).toEqual({ order_id: 'ORD-1', status: 'shipped', total: 99.99 });
  });

  it('reads nested body fields via dot-notation', () => {
    const body = { user: { address: { city: 'Amsterdam' } } };
    const mapping: MappingField[] = [
      { from: 'user.address.city', to: 'city', location: 'body' },
    ];
    const result = applyOutboundMapping(body, {}, mapping);
    expect(result).toEqual({ city: 'Amsterdam' });
  });

  it('maps a response header', () => {
    const mapping: MappingField[] = [
      { from: 'x-request-id', to: 'request_id', location: 'header' },
    ];
    const result = applyOutboundMapping({}, { 'x-request-id': 'req-abc' }, mapping);
    expect(result).toEqual({ request_id: 'req-abc' });
  });

  it('uses default when body field is missing', () => {
    const mapping: MappingField[] = [
      { from: 'missing_field', to: 'value', location: 'body', default: 'fallback' },
    ];
    const result = applyOutboundMapping({}, {}, mapping);
    expect(result).toEqual({ value: 'fallback' });
  });

  it('omits field when missing and no default', () => {
    const mapping: MappingField[] = [
      { from: 'missing', to: 'output', location: 'body' },
    ];
    const result = applyOutboundMapping({}, {}, mapping);
    expect(result).toEqual({});
  });

  it('applies a transform on output', () => {
    const body = { code: 'save20' };
    const mapping: MappingField[] = [
      { from: 'code', to: 'code', location: 'body', transform: 'uppercase' },
    ];
    const result = applyOutboundMapping(body, {}, mapping);
    expect(result).toEqual({ code: 'SAVE20' });
  });

  it('applies type coercion on output', () => {
    const body = { count: '42' };
    const mapping: MappingField[] = [
      { from: 'count', to: 'count', location: 'body', type: 'int' },
    ];
    const result = applyOutboundMapping(body, {}, mapping);
    expect(result).toEqual({ count: 42 });
  });

  it('handles multiple fields from mixed locations', () => {
    const body = { userId: 'u1' };
    const headers = { 'x-rate-limit': '100' };
    const mapping: MappingField[] = [
      { from: 'userId', to: 'id', location: 'body' },
      { from: 'x-rate-limit', to: 'rate_limit', location: 'header' },
    ];
    const result = applyOutboundMapping(body, headers, mapping);
    expect(result).toEqual({ id: 'u1', rate_limit: '100' });
  });
});
