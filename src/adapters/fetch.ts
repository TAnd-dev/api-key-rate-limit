import type { Limiter } from '../core/limiter.js';
import type { LimitResult } from '../core/types.js';
import { createDecider, type AdapterOptions } from './core.js';

export interface FetchLimiterOptions extends AdapterOptions<Request> {
  /** Custom 429 response. Default: JSON `{ error, message, retryAfter }`. Rate limit headers are added to it. */
  onLimited?: (request: Request, result: LimitResult) => Response | Promise<Response>;
}

export interface RateLimitCheck {
  /** Set when the request must be answered right away (401 or 429). */
  response?: Response;
  /** Rate limit headers to put on your own response. */
  headers: Headers;
  result?: LimitResult;
  /**
   * Pass the final status to enable `skipFailedRequests`. Call it without a
   * status if the client aborted: aborted requests are never refunded.
   */
  settle: (status?: number) => void;
}

/**
 * Low-level check for any Fetch-based framework (Hono, Next.js route
 * handlers, Bun, Deno, Workers):
 *
 * ```ts
 * const check = createRequestChecker(limiter, { getIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined });
 * // per request:
 * const result = await check(request);
 * if (result.response) return result.response;
 * ```
 */
export function createRequestChecker(
  limiter: Limiter,
  options: FetchLimiterOptions = {},
): (request: Request) => Promise<RateLimitCheck> {
  if ((options.anonymous || options.invalidKeys) && !options.getIp) {
    // A Fetch Request has no client address; only the platform knows it
    // (e.g. CF-Connecting-IP on Cloudflare, server.requestIP() in Bun).
    throw new TypeError('getIp is required with anonymous or invalidKeys in the Fetch adapter');
  }
  const decide = createDecider(limiter, options);
  return (request) => check(decide, request, options);
}

/**
 * One-off check. Prefer `createRequestChecker` (or `withRateLimit`) so state
 * such as the invalid-key IP blocklist survives between requests.
 */
export function checkRequest(limiter: Limiter, request: Request, options: FetchLimiterOptions = {}): Promise<RateLimitCheck> {
  return createRequestChecker(limiter, options)(request);
}

async function check(
  decide: ReturnType<typeof createDecider<Request>>,
  request: Request,
  options: FetchLimiterOptions,
): Promise<RateLimitCheck> {
  const decision = await decide(request);
  const noop = () => {};

  switch (decision.kind) {
    case 'skip':
      return { headers: new Headers(), settle: noop };

    case 'reject':
      return { response: Response.json(decision.body, { status: decision.status }), headers: new Headers(), settle: noop };

    case 'limited': {
      const headers = new Headers(decision.headers);
      const custom = options.onLimited && (await options.onLimited(request, decision.result));
      const response = custom
        ? withHeaders(custom, headers)
        : Response.json(decision.body, { status: decision.status, headers });
      return { response, headers, result: decision.result, settle: noop };
    }

    case 'allowed':
      return { headers: new Headers(decision.headers), result: decision.result, settle: decision.settle };
  }
}

/**
 * Wraps a Fetch handler: limited requests get 401/429, allowed ones get the
 * rate limit headers added to the handler's response (except responses
 * outside 200-599, such as `Response.error()` or a WebSocket upgrade, which
 * are returned unchanged).
 *
 * ```ts
 * export default { fetch: withRateLimit(limiter, (req) => new Response('ok')) };
 * ```
 */
export function withRateLimit<Args extends unknown[]>(
  limiter: Limiter,
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  options: FetchLimiterOptions = {},
): (request: Request, ...args: Args) => Promise<Response> {
  const checker = createRequestChecker(limiter, options);
  return async (request, ...args) => {
    const check = await checker(request);
    if (check.response) return check.response;

    let response: Response;
    try {
      response = await handler(request, ...args);
    } catch (err) {
      check.settle(500); // a crash is a server error, not a client abort
      throw err;
    }
    check.settle(response.status);
    return withHeaders(response, check.headers);
  };
}

function withHeaders(response: Response, headers: Headers): Response {
  if ([...headers].length === 0) return response;
  // Response.error() (status 0) and WebSocket upgrades (101) cannot be
  // rebuilt with `new Response`; pass them through without the headers.
  if (response.status < 200 || response.status > 599) return response;
  // Responses from fetch() or Response.redirect() have immutable headers; copy.
  const copy = new Response(response.body, response);
  headers.forEach((value, name) => copy.headers.set(name, value));
  return copy;
}
