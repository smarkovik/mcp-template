import type { MappingField } from '../types.js';
import { applyTransform, coerceType } from './transforms.js';

/** Get a value from a dot-notation path inside an object. */
function getDeep(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function applyOutboundMapping(
  upstreamBody: Record<string, unknown>,
  upstreamHeaders: Record<string, string>,
  mapping: MappingField[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of mapping) {
    let value: unknown;

    switch (field.location) {
      case 'body':
        value = getDeep(upstreamBody, field.from ?? field.to);
        break;
      case 'header':
        value = upstreamHeaders[(field.from ?? field.to).toLowerCase()];
        break;
      default:
        continue;
    }

    if (value === undefined || value === null) {
      if (field.default !== undefined) {
        value = field.default;
      } else {
        continue;
      }
    }

    if (field.type) value = coerceType(value, field.type);
    if (field.transform) value = applyTransform(value, field.transform);

    result[field.to] = value;
  }

  return result;
}
