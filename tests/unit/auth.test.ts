import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyProxyApiKey, isProxyAuthEnabled } from '../../src/auth.js';

// Helper to cleanly manage the PROXY_API_KEY env var across tests
const ENV_KEY = 'PROXY_API_KEY';
let original: string | undefined;

beforeEach(() => {
  original = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (original !== undefined) {
    process.env[ENV_KEY] = original;
  } else {
    delete process.env[ENV_KEY];
  }
});

// ────────────────────────────────────────────────────────────────────────────
// isProxyAuthEnabled
// ────────────────────────────────────────────────────────────────────────────

describe('isProxyAuthEnabled', () => {
  it('returns false when PROXY_API_KEY is not set', () => {
    expect(isProxyAuthEnabled()).toBe(false);
  });

  it('returns true when PROXY_API_KEY is set', () => {
    process.env[ENV_KEY] = 'any-key';
    expect(isProxyAuthEnabled()).toBe(true);
  });

  it('returns false when PROXY_API_KEY is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isProxyAuthEnabled()).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// verifyProxyApiKey — auth disabled (no PROXY_API_KEY)
// ────────────────────────────────────────────────────────────────────────────

describe('verifyProxyApiKey — auth disabled', () => {
  it('allows requests with no headers when auth is disabled', () => {
    expect(verifyProxyApiKey(undefined, undefined)).toBe(true);
  });

  it('allows requests with any Authorization header when auth is disabled', () => {
    expect(verifyProxyApiKey('Bearer wrong-key', undefined)).toBe(true);
  });

  it('allows requests with any X-Api-Key header when auth is disabled', () => {
    expect(verifyProxyApiKey(undefined, 'wrong-key')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// verifyProxyApiKey — auth enabled
// ────────────────────────────────────────────────────────────────────────────

describe('verifyProxyApiKey — auth enabled', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'super-secret';
  });

  it('rejects requests with no headers', () => {
    expect(verifyProxyApiKey(undefined, undefined)).toBe(false);
  });

  it('rejects requests with wrong Authorization Bearer key', () => {
    expect(verifyProxyApiKey('Bearer wrong', undefined)).toBe(false);
  });

  it('rejects requests with wrong X-Api-Key', () => {
    expect(verifyProxyApiKey(undefined, 'wrong')).toBe(false);
  });

  it('accepts the correct key via "Authorization: Bearer <key>"', () => {
    expect(verifyProxyApiKey('Bearer super-secret', undefined)).toBe(true);
  });

  it('accepts the correct key as a bare Authorization value (no "Bearer " prefix)', () => {
    expect(verifyProxyApiKey('super-secret', undefined)).toBe(true);
  });

  it('accepts the correct key via "X-Api-Key: <key>"', () => {
    expect(verifyProxyApiKey(undefined, 'super-secret')).toBe(true);
  });

  it('prioritises Authorization over X-Api-Key (wrong Auth but correct X-Api-Key still passes)', () => {
    // Both headers checked — correct key in either header is sufficient
    expect(verifyProxyApiKey('Bearer wrong', 'super-secret')).toBe(true);
  });

  it('is case-insensitive for the "Bearer" prefix', () => {
    expect(verifyProxyApiKey('BEARER super-secret', undefined)).toBe(true);
    expect(verifyProxyApiKey('bearer super-secret', undefined)).toBe(true);
    expect(verifyProxyApiKey('Bearer super-secret', undefined)).toBe(true);
  });

  it('is case-sensitive for the key value itself', () => {
    expect(verifyProxyApiKey('Bearer SUPER-SECRET', undefined)).toBe(false);
    expect(verifyProxyApiKey('Bearer Super-Secret', undefined)).toBe(false);
  });

  it('trims surrounding whitespace from the key', () => {
    expect(verifyProxyApiKey('Bearer  super-secret ', undefined)).toBe(true);
    expect(verifyProxyApiKey(undefined, '  super-secret  ')).toBe(true);
  });
});
