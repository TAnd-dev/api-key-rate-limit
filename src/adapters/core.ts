import type { Limiter } from '../core/limiter.js';
import type { LimitResult } from '../core/types.js';
import { rateLimitHeaders, type HeaderStyle } from './headers.js';
import { defaultGetIp, normalizeIp } from './ip.js';
import { defaultKeyExtractor, type KeyExtractor } from './keys.js';

/** What is known about a valid key. */
export interface KeyInfo {
  /** Limit for this key (e.g. from its plan) instead of the limiter's default. */
  limit?: number;
}

/** `true` or a `KeyInfo` object: valid. `false`, `null`, `undefined`: invalid. */
export type KeyCheck = boolean | KeyInfo | null | undefined;

/** Options shared by all framework adapters. */
export interface AdapterOptions<Req> {
  /** Where the API key comes from. Default: `X-API-Key`, then `Authorization: Bearer`. */
  getKey?: KeyExtractor<Req>;
  /** Weight of a request, fixed or per request (e.g. by route). Default: 1. */
  cost?: number | ((req: Req) => number | Promise<number>);
  /** Return true to bypass the limiter (health checks, internal callers). */
  skip?: (req: Req) => boolean | Promise<boolean>;
  /**
   * Refund requests whose response is a failure (see `isFailure`). Requests
   * aborted by the client are never refunded: the handler may have done the
   * work anyway. Default: false.
   */
  skipFailedRequests?: boolean;
  /**
   * What counts as a failure for `skipFailedRequests`. Default: status >= 500
   * (the server's fault). Counting 4xx as failures makes enumeration (404s,
   * 400s) free for the client, so only do that knowingly.
   */
  isFailure?: (status: number) => boolean;
  /** Rate limit response headers. Default: `draft-6`. */
  headers?: HeaderStyle | false;
  /**
   * Requests without a key (when `anonymous` is not set): `reject` answers
   * 401, `skip` lets them through unlimited (only if something else
   * authenticates them). Default: `reject`.
   */
  missingKey?: 'reject' | 'skip';
  /**
   * Errors that happen after the response is sent (a failed refund), where
   * they cannot reach the framework's error handler. Default: `console.error`.
   */
  onError?: (err: unknown) => void;

  /**
   * Checks that a key exists before it is counted. Invalid keys get 401 and
   * never reach the store, so random keys cannot flood it. Return
   * `{ limit }` to apply the key's plan:
   *
   * ```ts
   * validateKey: async (key) => {
   *   const row = await db.apiKeys.find(key);
   *   return row && { limit: PLANS[row.plan].perMinute };
   * }
   * ```
   */
  validateKey?: (key: string, req: Req) => KeyCheck | Promise<KeyCheck>;
  /**
   * Caches *successful* `validateKey` results in memory for `ttlMs`, and
   * merges concurrent lookups of the same key into one call. A revoked key
   * keeps working until its entry expires, so keep `ttlMs` short. With the
   * cache on, `validateKey` must depend on the key only, not on `req`.
   * Default: off.
   */
  cacheValidation?: { ttlMs: number; maxEntries?: number };
  /** Longer keys are treated as invalid without calling `validateKey`. Default: 256. */
  maxKeyLength?: number;
  /**
   * Limits requests *without* a key per client IP, instead of rejecting them
   * (public endpoints with a low anonymous quota).
   */
  anonymous?: Limiter;
  /**
   * Limits failed `validateKey` checks per client IP. Once an IP exhausts it,
   * this instance answers 429 for that IP without calling `validateKey`, so
   * key guessing cannot load your database. Requires `validateKey`.
   */
  invalidKeys?: Limiter;
  /**
   * Client address for `anonymous` / `invalidKeys`. Default: `req.ip`, then
   * the socket address (configure trust proxy in your framework). Required
   * for the Fetch adapter.
   */
  getIp?: (req: Req) => string | undefined;
  /**
   * IPv6 addresses are grouped by this prefix length. Default: 56. A /64 is
   * the usual minimum per customer, but /48s are handed out freely (tunnel
   * brokers, hosting), and with /64 grouping one /48 is 65 536 clients.
   */
  ipv6Subnet?: number;
}

export interface ErrorBody {
  error: 'missing_api_key' | 'invalid_api_key' | 'plan_limit_exceeded' | 'too_many_requests';
  message: string;
  retryAfter?: number;
}

export type Decision =
  | { kind: 'skip' }
  /** 401 (no or invalid key) or 403 (the request costs more than the key's plan allows). */
  | { kind: 'reject'; status: 401 | 403; body: ErrorBody }
  | { kind: 'limited'; status: 429; body: ErrorBody; result: LimitResult; headers: Record<string, string> }
  | {
      kind: 'allowed';
      result: LimitResult;
      headers: Record<string, string>;
      /**
       * Call once the response status is known, or with `undefined` if the
       * client aborted (never refunded). Refunds failures if configured.
       */
      settle: (status: number | undefined) => void;
    };

/**
 * Adapters count API keys and client IPs under separate namespaces, so a
 * client cannot send the key `ip:1.2.3.4` and use up that address's
 * anonymous quota when limiters share a store. To reset a key counted by an
 * adapter: `limiter.reset(apiKeyBucket(key))`.
 */
export const apiKeyBucket = (key: string): string => `key:${key}`;
export const ipBucket = (ip: string): string => `ip:${ip}`;

/** IPs blocked by `invalidKeys` are remembered per adapter instance, bounded. */
const MAX_BLOCKED_IPS = 10_000;

/** Builds the per-request decision function; state (the IP blocklist) lives in the closure. */
export function createDecider<Req>(limiter: Limiter, options: AdapterOptions<Req>) {
  const {
    getKey = defaultKeyExtractor as KeyExtractor<Req>,
    validateKey,
    maxKeyLength = 256,
    anonymous,
    invalidKeys,
    getIp = defaultGetIp,
    ipv6Subnet = 56,
    headers: headerStyle = 'draft-6',
  } = options;

  if (invalidKeys && !validateKey) throw new TypeError('invalidKeys requires validateKey');

  const lookup = validateKey && createKeyLookup(validateKey, options.cacheValidation);

  const blocked = new Map<string, number>();
  const clientId = (req: Req): string => {
    const ip = getIp(req);
    // Unknown address: one shared bucket. Safer than no limit; fix getIp.
    return ipBucket(ip ? normalizeIp(ip, ipv6Subnet) : 'unknown');
  };

  const REJECTIONS = {
    missing_api_key: { status: 401, message: 'An API key is required' },
    invalid_api_key: { status: 401, message: 'The API key is not valid' },
    plan_limit_exceeded: { status: 403, message: 'This endpoint is not available on your plan' },
  } as const;

  const reject = (error: keyof typeof REJECTIONS): Decision => ({
    kind: 'reject',
    status: REJECTIONS[error].status,
    body: { error, message: REJECTIONS[error].message },
  });

  const limited = (result: LimitResult, windowMs: number): Decision => {
    const headers = rateLimitHeaders(result, windowMs, headerStyle);
    return {
      kind: 'limited',
      status: 429,
      result,
      headers,
      body: { error: 'too_many_requests', message: 'Rate limit exceeded', retryAfter: Number(headers['Retry-After']) },
    };
  };

  /** Consumes on `lim` and turns the result into a decision. */
  const count = async (
    lim: Limiter,
    key: string,
    cost: number,
    limit: number | undefined,
    /** Answer when `cost` exceeds the limit: waiting would not help, so not 429. */
    tooCostly: 'missing_api_key' | 'plan_limit_exceeded',
  ): Promise<Decision> => {
    if (cost > (limit ?? lim.limit)) return reject(tooCostly);
    const consumeOptions = limit === undefined ? { cost } : { cost, limit };
    const result = await lim.consume(key, consumeOptions);
    if (!result.allowed) return limited(result, lim.windowMs);

    const isFailure = options.isFailure ?? ((status: number) => status >= 500);
    let settled = false;
    return {
      kind: 'allowed',
      result,
      headers: rateLimitHeaders(result, lim.windowMs, headerStyle),
      settle(status) {
        if (settled) return;
        settled = true;
        // Aborted (undefined): the handler may still have run, so it counts.
        if (!options.skipFailedRequests || status === undefined || !isFailure(status)) return;
        lim.refund(key, consumeOptions).catch(options.onError ?? console.error);
      },
    };
  };

  const blockedFor = (id: string): number => {
    const until = blocked.get(id);
    if (until === undefined) return 0;
    const left = until - Date.now();
    if (left <= 0) blocked.delete(id);
    return Math.max(0, left);
  };

  const block = (id: string, ms: number) => {
    blocked.delete(id);
    blocked.set(id, Date.now() + ms);
    if (blocked.size > MAX_BLOCKED_IPS) blocked.delete(blocked.keys().next().value!);
  };

  /** Rejects an invalid key, counting the attempt against the client's IP. */
  const rejectInvalid = async (id: string): Promise<Decision> => {
    if (!invalidKeys) return reject('invalid_api_key');
    const result = await invalidKeys.consume(id);
    if (result.allowed) return reject('invalid_api_key');
    block(id, result.retryAfterMs);
    return limited(result, invalidKeys.windowMs);
  };

  return async function decide(req: Req): Promise<Decision> {
    if (options.skip && (await options.skip(req))) return { kind: 'skip' };

    const cost = typeof options.cost === 'function' ? await options.cost(req) : (options.cost ?? 1);
    const key = await getKey(req);

    if (!key) {
      if (anonymous) return count(anonymous, clientId(req), cost, undefined, 'missing_api_key');
      return options.missingKey === 'skip' ? { kind: 'skip' } : reject('missing_api_key');
    }

    let info: KeyInfo | undefined;
    if (lookup) {
      const id = invalidKeys ? clientId(req) : '';
      if (invalidKeys) {
        const left = blockedFor(id);
        if (left > 0) {
          return limited(
            { allowed: false, limit: invalidKeys.limit, remaining: 0, resetMs: left, retryAfterMs: left },
            invalidKeys.windowMs,
          );
        }
      }
      if (key.length > maxKeyLength) return rejectInvalid(id);
      info = await lookup(key, req);
      if (!info) return rejectInvalid(id);
    } else if (key.length > maxKeyLength) {
      return reject('invalid_api_key');
    }

    return count(limiter, apiKeyBucket(key), cost, info?.limit, 'plan_limit_exceeded');
  };
}

/** Wraps `validateKey` with the optional positive cache and single-flight. */
function createKeyLookup<Req>(
  validateKey: (key: string, req: Req) => KeyCheck | Promise<KeyCheck>,
  cacheOptions: AdapterOptions<Req>['cacheValidation'],
): (key: string, req: Req) => Promise<KeyInfo | undefined> {
  const normalize = (check: KeyCheck): KeyInfo | undefined =>
    check === true ? {} : check ? check : undefined;

  if (!cacheOptions) return async (key, req) => normalize(await validateKey(key, req));

  const { ttlMs, maxEntries = 10_000 } = cacheOptions;
  if (!(ttlMs > 0)) throw new RangeError('cacheValidation.ttlMs must be > 0');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('cacheValidation.maxEntries must be a positive integer');
  }

  const cache = new Map<string, { info: KeyInfo; expiresAt: number }>();
  const inflight = new Map<string, Promise<KeyInfo | undefined>>();

  return async (key, req) => {
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      if (hit.expiresAt > Date.now()) {
        cache.set(key, hit); // most recently used
        return hit.info;
      }
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const info = normalize(await validateKey(key, req));
        // Only valid keys are cached: random invalid keys would evict real ones.
        if (info) {
          cache.set(key, { info, expiresAt: Date.now() + ttlMs });
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
        }
        return info;
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  };
}
