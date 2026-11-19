import { ALGORITHMS } from '../algorithms/index.js';
import { createKeyHasher, type HashKeysOption } from './hash.js';
import { MemoryStore } from '../stores/memory.js';
import { CircuitBreaker, StoreUnavailableError, withTimeout, type CircuitBreakerOptions } from './resilience.js';
import type { Algorithm, ConsumeRequest, LimitResult, Store } from './types.js';

export type StoreErrorPolicy = 'fail-open' | 'fail-closed' | 'throw';

export interface StoreErrorInfo {
  operation: 'consume' | 'refund' | 'reset';
  /** Which store failed. */
  store: 'primary' | 'fallback';
  /**
   * Identifier of the key as stored: its hash unless `hashKeys` is false.
   * Safe to log; the raw key is deliberately not passed.
   */
  keyId: string;
}

export interface LimiterOptions {
  store: Store;
  /** Max units per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  algorithm?: Algorithm;
  /**
   * Namespace for storage keys. Storage keys also include the algorithm and
   * `windowMs`, so limiters that differ in either can share a store as is.
   * Two limiters with the same algorithm and window on the same store need
   * distinct prefixes, or they would count into one counter; creating such a
   * pair throws. Default: `akl`.
   */
  prefix?: string;
  /**
   * How keys are stored:
   * - `true` (default): SHA-256, base64url.
   * - `{ secret }`: HMAC-SHA-256; also protects short, guessable keys. Changing
   *   the secret resets all counters.
   * - a function: your own mapping.
   * - `false`: raw keys (they will be visible in Redis).
   */
  hashKeys?: HashKeysOption;

  /**
   * Max time for one store call. Redis clients queue commands while
   * disconnected, so without a timeout requests can hang. `Infinity`
   * disables it. Default: 1 000 ms.
   */
  timeoutMs?: number;
  /**
   * Used when the primary store fails, times out or its circuit is open:
   * per-instance limits are better than none. `limit` lets you scale it
   * down, e.g. `Math.ceil(limit / instanceCount)`; per-key limits are scaled
   * by the same ratio. Default: a `MemoryStore` with the same limit (none if
   * the primary is a `MemoryStore`). `false` disables it, so `onStoreError`
   * applies as soon as the primary fails.
   */
  fallback?: { store: Store; limit?: number } | false;
  /**
   * What to do when no store could answer (the primary failed and there is
   * no fallback, or it failed too):
   * - `fail-open`: allow the request (availability first). Default.
   * - `fail-closed`: deny it with a short Retry-After (protection first).
   * - `throw`: reject the promise and let the caller decide.
   */
  onStoreError?: StoreErrorPolicy;
  /** Circuit breaker around the primary store; `false` disables it. */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Called for every store failure, including ones that were recovered from. */
  onError?: (error: unknown, info: StoreErrorInfo) => void;
}

export interface ConsumeOptions {
  /** Weight of this request. Default: 1. */
  cost?: number;
  /**
   * Limit for this key instead of the limiter's default, e.g. from the key's
   * plan. The window stays the limiter's `windowMs`; use one limiter per
   * window length. Pass the same value to `refund`.
   */
  limit?: number;
}

export interface Limiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly algorithm: Algorithm;
  consume(key: string, options?: ConsumeOptions): Promise<LimitResult>;
  /** Clears the key in the primary and the fallback store. Errors are not swallowed. */
  reset(key: string): Promise<void>;
  /**
   * Gives back units taken by an allowed `consume` with the same `cost`, e.g.
   * when the request failed. Do not call it for denied requests: they were
   * not counted. Best effort: failures are reported via `onError` and only
   * rethrown with `onStoreError: 'throw'`.
   */
  refund(key: string, options?: ConsumeOptions): Promise<void>;
}

/**
 * Namespaces in use per store object. Two limiters writing the same storage
 * keys corrupt each other's counters (double counting, or a full bypass when
 * the windows differ), so a second one is refused. Only stores shared within
 * one process can be checked; across processes, the prefix is up to you.
 */
const namespaces = new WeakMap<object, Set<string>>();

function claimNamespace(store: Store, namespace: string): void {
  let used = namespaces.get(store);
  if (!used) namespaces.set(store, (used = new Set()));
  if (used.has(namespace)) {
    throw new TypeError(
      `Another limiter already uses the storage namespace "${namespace}" on this store, so both would count ` +
        'into the same counters. Pass a distinct `prefix`, or reuse the existing limiter: create limiters ' +
        'once, at startup, not per request.',
    );
  }
  used.add(namespace);
}

/** Retry-After for `fail-closed`: short, the outage is not the client's fault. */
const FAIL_CLOSED_RETRY_MS = 1_000;

export function createLimiter(options: LimiterOptions): Limiter {
  const {
    store,
    limit,
    windowMs,
    algorithm = 'sliding-window',
    prefix = 'akl',
    hashKeys = true,
    timeoutMs = 1_000,
    fallback: fallbackOption,
    onStoreError = 'fail-open',
    onError,
  } = options;

  assertPositiveInteger('limit', limit);
  assertPositiveInteger('windowMs', windowMs);
  assertExactRange(limit, windowMs);
  if (!ALGORITHMS.includes(algorithm)) {
    throw new TypeError(`Unknown algorithm: ${String(algorithm)}`);
  }
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be > 0');
  if (!['fail-open', 'fail-closed', 'throw'].includes(onStoreError)) {
    throw new TypeError(`Unknown onStoreError policy: ${String(onStoreError)}`);
  }
  // Without a fallback, a slow or unreachable Redis would turn fail-open into
  // "no limit at all", and an attacker able to slow Redis down could do that.
  const fallback =
    fallbackOption === false
      ? undefined
      : (fallbackOption ?? (store instanceof MemoryStore ? undefined : { store: new MemoryStore() }));
  const fallbackLimit = fallback?.limit ?? limit;
  if (fallback) {
    assertPositiveInteger('fallback.limit', fallbackLimit);
    assertExactRange(fallbackLimit, windowMs);
  }

  // windowMs is part of the namespace: limiters with different windows would
  // otherwise read each other's state as their own.
  const namespace = `${prefix}:${algorithm}:${windowMs}`;

  const breaker = options.circuitBreaker === false ? undefined : new CircuitBreaker(options.circuitBreaker);

  const report = (error: unknown, info: StoreErrorInfo) => {
    try {
      onError?.(error, info);
    } catch {
      // A broken error hook must not break rate limiting.
    }
  };

  const hash = createKeyHasher(hashKeys);

  /** Validates the key and returns its id (hash) and the full storage key. */
  const resolveKey = async (key: string) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('key must be a non-empty string');
    }
    const keyId = await hash(key);
    return { keyId, storageKey: `${namespace}:${keyId}` };
  };

  const request = async (
    key: string,
    { cost = 1, limit: keyLimit = limit }: ConsumeOptions,
  ): Promise<{ req: ConsumeRequest; keyId: string }> => {
    assertPositiveInteger('cost', cost);
    if (keyLimit !== limit) {
      assertPositiveInteger('limit', keyLimit);
      assertExactRange(keyLimit, windowMs);
    }
    if (cost > keyLimit) {
      throw new RangeError(`cost (${cost}) exceeds limit (${keyLimit}); the request could never be allowed`);
    }
    const { keyId, storageKey } = await resolveKey(key);
    return { req: { key: storageKey, algorithm, limit: keyLimit, windowMs, cost }, keyId };
  };

  /** The fallback limit scales with per-key limits: same ratio as the defaults. */
  const fallbackLimitFor = (keyLimit: number): number =>
    keyLimit === limit ? fallbackLimit : Math.max(1, Math.floor((keyLimit * fallbackLimit) / limit));

  /** Runs `op` on the primary store through the breaker and timeout. */
  async function primary<T>(op: () => Promise<T>, info: Omit<StoreErrorInfo, 'store'>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    if (breaker && !breaker.tryAcquire()) return { ok: false, error: undefined };
    try {
      const value = await withTimeout(op(), timeoutMs);
      breaker?.success();
      return { ok: true, value };
    } catch (error) {
      breaker?.failure();
      report(error, { ...info, store: 'primary' });
      return { ok: false, error };
    }
  }

  async function consumeFallback(req: ConsumeRequest, keyId: string): Promise<LimitResult | undefined> {
    if (!fallback) return undefined;
    const fbLimit = fallbackLimitFor(req.limit);
    const fbReq = { ...req, limit: fbLimit };
    if (req.cost > fbLimit) {
      // Could never fit into the reduced limit; deny without touching the store.
      return { allowed: false, limit: fbLimit, remaining: 0, resetMs: windowMs, retryAfterMs: windowMs, degraded: 'fallback' };
    }
    try {
      const result = await withTimeout(fallback.store.consume(fbReq), timeoutMs);
      return { ...result, degraded: 'fallback' };
    } catch (error) {
      report(error, { operation: 'consume', store: 'fallback', keyId });
      return undefined;
    }
  }

  // Last, once every option has been validated: a throw above must not leave
  // the namespace taken.
  claimNamespace(store, namespace);
  if (fallback && fallback.store !== store) claimNamespace(fallback.store, namespace);

  return {
    limit,
    windowMs,
    algorithm,

    async consume(key, options = {}) {
      const { req, keyId } = await request(key, options);

      const res = await primary(() => store.consume(req), { operation: 'consume', keyId });
      if (res.ok) return res.value;

      const fromFallback = await consumeFallback(req, keyId);
      if (fromFallback) return fromFallback;

      switch (onStoreError) {
        case 'throw':
          // Rethrow the store's own error as is, whatever its type.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw res.error ?? new StoreUnavailableError();
        case 'fail-closed':
          return { allowed: false, limit: req.limit, remaining: 0, resetMs: FAIL_CLOSED_RETRY_MS, retryAfterMs: FAIL_CLOSED_RETRY_MS, degraded: 'fail-closed' };
        case 'fail-open':
          return { allowed: true, limit: req.limit, remaining: req.limit, resetMs: 0, retryAfterMs: 0, degraded: 'fail-open' };
      }
    },

    async refund(key, options = {}) {
      const { req, keyId } = await request(key, options);
      const refundPrimary = store.refund?.bind(store);
      if (!refundPrimary) throw new TypeError('This store does not support refund');

      // Refund where the request was most likely counted: the primary when it
      // is healthy, otherwise the fallback.
      const res = await primary(() => refundPrimary(req), { operation: 'refund', keyId });
      if (res.ok) return;

      let error: unknown = res.error ?? new StoreUnavailableError();
      const refundFallback = fallback?.store.refund?.bind(fallback.store);
      if (refundFallback) {
        try {
          await withTimeout(refundFallback({ ...req, limit: fallbackLimitFor(req.limit) }), timeoutMs);
          return;
        } catch (fallbackError) {
          report(fallbackError, { operation: 'refund', store: 'fallback', keyId });
          error = fallbackError;
        }
      }
      if (onStoreError === 'throw') throw error;
    },

    async reset(key) {
      const { storageKey: storage } = await resolveKey(key);
      await Promise.all([
        withTimeout(store.reset(storage), timeoutMs),
        fallback && withTimeout(fallback.store.reset(storage), timeoutMs),
      ]);
    },
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

function assertExactRange(limit: number, windowMs: number): void {
  // Algorithms compute in units of limit * windowMs to stay exact.
  if (limit * windowMs * 2 > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('limit * windowMs is too large to be computed exactly');
  }
}
