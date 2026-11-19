/**
 * - `sliding-window`: at most `limit` units over any `windowMs` (approximated
 *   from two fixed-window counters). Smooth, no bursts above `limit`.
 * - `token-bucket`: bursts of up to `limit` units, refilled at `limit / windowMs`
 *   units per ms.
 */
export type Algorithm = 'sliding-window' | 'token-bucket';

/** Outcome of a single `consume` call. All durations are in milliseconds. */
export interface LimitResult {
  /** Whether the request fits into the limit (and was counted). */
  allowed: boolean;
  /** The limit that was applied. */
  limit: number;
  /** How many more units can be consumed right now. Never negative. */
  remaining: number;
  /**
   * sliding-window: time until the current fixed window ends.
   * token-bucket: time until the bucket is full again.
   */
  resetMs: number;
  /** When denied: how long to wait before the same request would be allowed. 0 when allowed. */
  retryAfterMs: number;
  /**
   * Set when the primary store could not answer:
   * `fallback` — counted in the fallback store; `fail-open` / `fail-closed` —
   * not counted at all, the configured policy decided.
   */
  degraded?: 'fallback' | 'fail-open' | 'fail-closed';
}

export interface ConsumeRequest {
  /** Fully qualified storage key (already prefixed by the limiter). */
  key: string;
  algorithm: Algorithm;
  limit: number;
  windowMs: number;
  cost: number;
}

/**
 * Storage backend. A store owns the whole read-check-write cycle so it can
 * make it atomic (e.g. a single Lua script in Redis).
 */
export interface Store {
  consume(request: ConsumeRequest): Promise<LimitResult>;
  reset(key: string): Promise<void>;
  /**
   * Gives back `cost` units consumed earlier (e.g. the request failed).
   * Optional for custom stores; `limiter.refund` rejects if missing.
   */
  refund?(request: ConsumeRequest): Promise<void>;
  close?(): Promise<void>;
}
