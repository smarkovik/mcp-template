/**
 * Proxy-level API key authentication.
 *
 * When the `PROXY_API_KEY` environment variable is set, every incoming MCP
 * request must supply a matching key in one of these two HTTP headers:
 *
 *   Authorization: Bearer <key>
 *   X-Api-Key: <key>
 *
 * If the variable is **not** set (default), authentication is disabled and all
 * requests are allowed through — useful for local development and testing.
 *
 * This is independent of the per-tool upstream authentication configured in
 * `config/tools.yaml` (which controls how the proxy authenticates against
 * third-party APIs, not how clients authenticate against the proxy).
 */

/** Returns `true` when proxy-level auth is active (`PROXY_API_KEY` is set). */
export function isProxyAuthEnabled(): boolean {
  return Boolean(process.env['PROXY_API_KEY']);
}

/**
 * Verify that the incoming request carries the correct proxy API key.
 *
 * Returns `true` if the request is authorised (or auth is disabled).
 * Returns `false` if the provided key is missing or incorrect.
 *
 * Accepted formats:
 *   `Authorization: Bearer <key>`   — standard Bearer token
 *   `Authorization: <key>`          — bare token (no "Bearer" prefix)
 *   `X-Api-Key: <key>`             — alternative header
 *
 * The Bearer prefix is matched case-insensitively.
 *
 * @param authorizationHeader  Value of the `authorization` header (or undefined)
 * @param xApiKeyHeader        Value of the `x-api-key` header (or undefined)
 */
export function verifyProxyApiKey(
  authorizationHeader: string | undefined,
  xApiKeyHeader: string | undefined,
): boolean {
  const proxyApiKey = process.env['PROXY_API_KEY'];
  if (!proxyApiKey) return true; // auth disabled — allow all

  // Strip optional "Bearer " prefix from the Authorization header
  const bearerKey = (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  const xKey = (xApiKeyHeader ?? '').trim();

  return bearerKey === proxyApiKey || xKey === proxyApiKey;
}
