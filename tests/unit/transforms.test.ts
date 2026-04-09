import { describe, it, expect } from 'vitest';
import { applyTransform, coerceType } from '../../src/transform/transforms.js';

describe('applyTransform', () => {
  describe('string transforms', () => {
    it('uppercase', () => expect(applyTransform('hello', 'uppercase')).toBe('HELLO'));
    it('lowercase', () => expect(applyTransform('WORLD', 'lowercase')).toBe('world'));
    it('to_string coerces number', () => expect(applyTransform(42, 'to_string')).toBe('42'));
    it('to_string coerces boolean', () => expect(applyTransform(true, 'to_string')).toBe('true'));
  });

  describe('numeric transforms', () => {
    it('to_int from string', () => expect(applyTransform('42', 'to_int')).toBe(42));
    it('to_int from float string rounds down', () => expect(applyTransform('3.9', 'to_int')).toBe(3));
    it('to_int throws on non-numeric', () => {
      expect(() => applyTransform('abc', 'to_int')).toThrow('TRANSFORM_ERROR');
    });

    it('to_float from string', () => expect(applyTransform('3.14', 'to_float')).toBe(3.14));
    it('to_float throws on non-numeric', () => {
      expect(() => applyTransform('xyz', 'to_float')).toThrow('TRANSFORM_ERROR');
    });
  });

  describe('boolean transforms', () => {
    it('to_boolean from true', () => expect(applyTransform('true', 'to_boolean')).toBe(true));
    it('to_boolean from 1', () => expect(applyTransform('1', 'to_boolean')).toBe(true));
    it('to_boolean from false', () => expect(applyTransform('false', 'to_boolean')).toBe(false));
    it('to_boolean from 0', () => expect(applyTransform('0', 'to_boolean')).toBe(false));
    it('to_boolean passthrough native boolean', () => expect(applyTransform(true, 'to_boolean')).toBe(true));
    it('to_boolean throws on unknown', () => {
      expect(() => applyTransform('maybe', 'to_boolean')).toThrow('TRANSFORM_ERROR');
    });
  });

  describe('date transforms', () => {
    it('iso_to_unix converts ISO string to unix timestamp', () => {
      expect(applyTransform('2025-01-01T00:00:00Z', 'iso_to_unix')).toBe(1735689600);
    });
    it('iso_to_unix throws on invalid date', () => {
      expect(() => applyTransform('not-a-date', 'iso_to_unix')).toThrow('TRANSFORM_ERROR');
    });

    it('unix_to_iso converts unix timestamp to ISO string', () => {
      expect(applyTransform(1735689600, 'unix_to_iso')).toBe('2025-01-01T00:00:00.000Z');
    });
    it('unix_to_iso throws on NaN', () => {
      expect(() => applyTransform('abc', 'unix_to_iso')).toThrow('TRANSFORM_ERROR');
    });
  });

  describe('base64 transforms', () => {
    it('base64_encode', () => expect(applyTransform('hello', 'base64_encode')).toBe('aGVsbG8='));
    it('base64_decode', () => expect(applyTransform('aGVsbG8=', 'base64_decode')).toBe('hello'));
    it('roundtrips', () => {
      const encoded = applyTransform('test-value-123', 'base64_encode') as string;
      expect(applyTransform(encoded, 'base64_decode')).toBe('test-value-123');
    });
  });

  describe('json transforms', () => {
    it('json_stringify', () => {
      expect(applyTransform({ a: 1 }, 'json_stringify')).toBe('{"a":1}');
    });
    it('json_parse', () => {
      expect(applyTransform('{"a":1}', 'json_parse')).toEqual({ a: 1 });
    });
    it('json_parse throws on invalid JSON', () => {
      expect(() => applyTransform('not json', 'json_parse')).toThrow('TRANSFORM_ERROR');
    });
    it('json roundtrips', () => {
      const obj = { x: [1, 2, 3], y: 'str' };
      const str = applyTransform(obj, 'json_stringify') as string;
      expect(applyTransform(str, 'json_parse')).toEqual(obj);
    });
  });
});

describe('coerceType', () => {
  it('string', () => expect(coerceType(99, 'string')).toBe('99'));
  it('int', () => expect(coerceType('7', 'int')).toBe(7));
  it('integer', () => expect(coerceType('7', 'integer')).toBe(7));
  it('float', () => expect(coerceType('1.5', 'float')).toBe(1.5));
  it('number', () => expect(coerceType('1.5', 'number')).toBe(1.5));
  it('boolean true', () => expect(coerceType('true', 'boolean')).toBe(true));
  it('unknown type passes value through', () => expect(coerceType({ a: 1 }, 'object')).toEqual({ a: 1 }));
});
