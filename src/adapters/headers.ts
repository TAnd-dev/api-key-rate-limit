import type { LimitResult } from '../core/types.js';

/**
 * - `draft-6`: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds
 *   from now), `RateLimit-Policy` — IETF draft 6/7, the most widely recognised form.
 * - `draft-8`: structured `RateLimit` and `RateLimit-Policy` fields (IETF draft 8+).
 * - `legacy`: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
 *   (Unix time in seconds, as GitHub and others do).
 *
 * `Retry-After` (seconds) is always sent with 429, whatever the style.
 */
export type HeaderStyle = 'draft-6' | 'draft-8' | 'legacy';

export function rateLimitHeaders(
  result: LimitResult,
  windowMs: number,
  style: HeaderStyle | false,
  now: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {};
  const resetSec = Math.ceil(result.resetMs / 1000);
  const windowSec = Math.ceil(windowMs / 1000);

  switch (style) {
    case 'draft-6':
      headers['RateLimit-Policy'] = `${result.limit};w=${windowSec}`;
      headers['RateLimit-Limit'] = String(result.limit);
      headers['RateLimit-Remaining'] = String(result.remaining);
      headers['RateLimit-Reset'] = String(resetSec);
      break;
    case 'draft-8':
      headers['RateLimit-Policy'] = `"default";q=${result.limit};w=${windowSec}`;
      headers['RateLimit'] = `"default";r=${result.remaining};t=${resetSec}`;
      break;
    case 'legacy':
      headers['X-RateLimit-Limit'] = String(result.limit);
      headers['X-RateLimit-Remaining'] = String(result.remaining);
      headers['X-RateLimit-Reset'] = String(Math.ceil((now + result.resetMs) / 1000));
      break;
    case false:
      break;
  }

  if (!result.allowed) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  }
  return headers;
}
