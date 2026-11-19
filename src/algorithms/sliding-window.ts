import type { AlgorithmOutcome, AlgorithmParams } from './types.js';

/**
 * Sliding window counter.
 *
 * Keeps counts for the current and the previous fixed window and estimates
 * the load over the last `windowMs` as
 *   previous * (portion of previous window still inside the sliding window) + current.
 * This avoids the 2x burst that a plain fixed window allows at its boundary,
 * while storing only two numbers per key.
 */
export interface SlidingWindowState {
  /** Index of the current fixed window: floor(now / windowMs). */
  window: number;
  current: number;
  previous: number;
}

type SlidingWindowParams = AlgorithmParams;
type SlidingWindowOutcome = AlgorithmOutcome<SlidingWindowState>;

export function slidingWindow(
  prev: SlidingWindowState | undefined,
  now: number,
  { limit, windowMs, cost }: SlidingWindowParams,
): SlidingWindowOutcome {
  // The clock stepped back behind the stored window:
  // - by up to a window (NTP corrections): keep counting in the stored window
  //   as if at its start, rather than wiping the counters;
  // - further: the state was written by a clock that was wrong, and trusting
  //   it would lock the key out until real time caught up (hours, say), so
  //   start over. Worst case, one fresh limit after a large clock jump.
  if (prev && prev.window === Math.floor(now / windowMs) + 1) now = prev.window * windowMs;
  else if (prev && prev.window > Math.floor(now / windowMs)) prev = undefined;
  const window = Math.floor(now / windowMs);
  let current = 0;
  let previous = 0;

  if (prev) {
    if (prev.window === window) {
      current = prev.current;
      previous = prev.previous;
    } else if (prev.window === window - 1) {
      previous = prev.current;
    }
  }

  const elapsed = now - window * windowMs;
  const resetMs = windowMs - elapsed;

  // Everything is scaled by windowMs to stay in integers: float weights like
  // 0.7 make `<=` comparisons and the retry-after computation off by one.
  const capacity = limit * windowMs;
  const estimated = previous * (windowMs - elapsed) + current * windowMs;

  const allowed = estimated + cost * windowMs <= capacity;
  if (allowed) current += cost;

  const used = allowed ? estimated + cost * windowMs : estimated;
  const remaining = Math.max(0, Math.floor((capacity - used) / windowMs));

  // A denied request leaves the stored state untouched, like the Lua port
  // (which skips the write). The meaning is the same while time moves
  // forward, but a clock that steps back must find the same window in both.
  const state: SlidingWindowState = allowed || !prev ? { window, current, previous } : prev;
  return {
    state,
    expiresAt: (state.window + 2) * windowMs,
    result: {
      allowed,
      limit,
      remaining,
      resetMs,
      retryAfterMs: allowed ? 0 : retryAfter(previous, current, elapsed, { limit, windowMs, cost }),
    },
  };
}

/** Smallest wait after which `estimated + cost <= limit` holds again. */
function retryAfter(
  previous: number,
  current: number,
  elapsed: number,
  { limit, windowMs, cost }: SlidingWindowParams,
): number {
  // Still in this window, smallest integer t with
  //   previous * (W - t) <= (limit - current - cost) * W
  // i.e. t = W - floor(budget * W / previous).
  const budgetNow = limit - current - cost;
  if (budgetNow >= 0 && previous > 0) {
    const t = windowMs - Math.floor((budgetNow * windowMs) / previous);
    return Math.max(1, t - elapsed);
  }

  // Next window: `current` becomes `previous` and decays the same way.
  const untilNext = windowMs - elapsed;
  const budgetNext = limit - cost;
  if (current <= budgetNext) return Math.max(1, untilNext);
  const t = windowMs - Math.floor((budgetNext * windowMs) / current);
  return Math.max(1, untilNext + t);
}

/**
 * Removes `cost` from the most recently written window. Exact unless the window
 * rolled over between the consume and the refund *and* another request was
 * counted in the new window meanwhile; then the refund lands in the new window.
 */
export function refundSlidingWindow(state: SlidingWindowState, cost: number): SlidingWindowState {
  return { ...state, current: Math.max(0, state.current - cost) };
}
