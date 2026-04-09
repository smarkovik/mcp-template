import type { BuiltinTransform } from '../types.js';

export function applyTransform(value: unknown, transform: BuiltinTransform): unknown {
  switch (transform) {
    case 'uppercase':
      return String(value).toUpperCase();
    case 'lowercase':
      return String(value).toLowerCase();
    case 'to_string':
      return String(value);
    case 'to_int': {
      const n = parseInt(String(value), 10);
      if (isNaN(n)) throw new Error(`TRANSFORM_ERROR: Cannot convert "${value}" to int`);
      return n;
    }
    case 'to_float': {
      const n = parseFloat(String(value));
      if (isNaN(n)) throw new Error(`TRANSFORM_ERROR: Cannot convert "${value}" to float`);
      return n;
    }
    case 'to_boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      throw new Error(`TRANSFORM_ERROR: Cannot convert "${value}" to boolean`);
    }
    case 'iso_to_unix': {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) throw new Error(`TRANSFORM_ERROR: Invalid ISO date "${value}"`);
      return Math.floor(d.getTime() / 1000);
    }
    case 'unix_to_iso': {
      const n = Number(value);
      if (isNaN(n)) throw new Error(`TRANSFORM_ERROR: Invalid unix timestamp "${value}"`);
      return new Date(n * 1000).toISOString();
    }
    case 'base64_encode':
      return Buffer.from(String(value)).toString('base64');
    case 'base64_decode':
      return Buffer.from(String(value), 'base64').toString('utf-8');
    case 'json_stringify':
      return JSON.stringify(value);
    case 'json_parse': {
      try {
        return JSON.parse(String(value));
      } catch {
        throw new Error(`TRANSFORM_ERROR: Invalid JSON string "${value}"`);
      }
    }
    default: {
      const _exhaustive: never = transform;
      throw new Error(`TRANSFORM_ERROR: Unknown transform "${_exhaustive}"`);
    }
  }
}

export function coerceType(value: unknown, type: string): unknown {
  switch (type) {
    case 'string': return String(value);
    case 'int':
    case 'integer': return applyTransform(value, 'to_int');
    case 'float':
    case 'number': return applyTransform(value, 'to_float');
    case 'boolean': return applyTransform(value, 'to_boolean');
    default: return value;
  }
}
