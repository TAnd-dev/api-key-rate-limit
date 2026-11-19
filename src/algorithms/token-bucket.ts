import type { AlgorithmOutcome, AlgorithmParams } from './types.js';

/**
 * Token bucket.
 *
 * The bucket holds up to `limit` tokens and refills continuously at
 * `limit / windowMs` tokens per ms, so a client can burst up to `limit`
 * requests and is then held to the average rate.
 *
 * Tokens are stored scaled by `windowMs` (one token = `windowMs` units), which
 * makes the refill exactly `limit` units per ms and keeps all math in integers.
 */
export interface TokenBucketState {
  /** Scaled tokens, 0..limit * windowMs. */
  tokens: number;
  /** Time of the last refill. */
  updatedAt: number;
}

export function tokenBucket(
  prev: TokenBucketState | undefined,
  now: number,
  { limit, windowMs, cost }: AlgorithmParams,
): AlgorithmOutcome<TokenBucketState> {
  const capacity = limit * windowMs;
  let tokens = capacity;

  // Written by a clock more than a window ahead (later corrected): without
  // this, the bucket would not refill until real time caught up. Within a
  // window, the clamp below just pauses the refill until then.
  if (prev && prev.updatedAt - now > windowMs) prev = undefined;

  if (prev) {
    // Clamp: a clock that jumps backwards must not drain the bucket, and
    // anything beyond one window refills it completely (also avoids overflow).
    const elapsed = Math.min(Math.max(0, now - prev.updatedAt), windowMs);
    tokens = Math.min(capacity, prev.tokens + elapsed * limit);
  }

  const need = cost * windowMs;
  const allowed = tokens >= need;
  if (allowed) tokens -= need;

  const resetMs = Math.ceil((capacity - tokens) / limit);

  return {
    // A denied request leaves the state untouched, exactly like the Lua port
    // (which skips the write). Refill is linear, so this changes nothing while
    // the limit is constant, but it keeps both stores identical when a key's
    // limit (plan) changes between requests.
    state: allowed || !prev ? { tokens, updatedAt: now } : prev,
    // Once full, the state is identical to "no state".
    expiresAt: now + resetMs,
    result: {
      allowed,
      limit,
      remaining: Math.floor(tokens / windowMs),
      resetMs,
      retryAfterMs: allowed ? 0 : Math.ceil((need - tokens) / limit),
    },
  };
}

/** Puts `cost` tokens back, never above capacity. */
export function refundTokenBucket(
  state: TokenBucketState,
  { limit, windowMs, cost }: AlgorithmParams,
): TokenBucketState {
  return { ...state, tokens: Math.min(limit * windowMs, state.tokens + cost * windowMs) };
}
