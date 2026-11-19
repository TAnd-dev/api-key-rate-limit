import { describe, expect, it } from 'vitest';
import { slidingWindow, type SlidingWindowState } from '../src/algorithms/sliding-window.js';

const W = 1000;
const params = (limit: number, cost = 1) => ({ limit, windowMs: W, cost });

/** Runs `n` consumes at time `now`, threading state through. */
function run(state: SlidingWindowState | undefined, now: number, n: number, limit: number) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const out = slidingWindow(state, now, params(limit));
    state = out.state;
    results.push(out.result);
  }
  return { state, results };
}

describe('slidingWindow', () => {
  it('allows exactly `limit` requests in a fresh window', () => {
    const { results } = run(undefined, 0, 11, 10);
    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10]!.allowed).toBe(false);
    expect(results.map((r) => r.remaining).slice(0, 10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('does not allow a 2x burst across the window boundary', () => {
    const first = run(undefined, 999, 10, 10);
    expect(first.results.every((r) => r.allowed)).toBe(true);

    // A fixed window would reset here; the sliding estimate is still 10.
    const atBoundary = slidingWindow(first.state, 1000, params(10));
    expect(atBoundary.result.allowed).toBe(false);

    // Halfway through the next window half of the previous count still applies.
    const half = run(first.state, 1500, 6, 10);
    expect(half.results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('forgets everything after two idle windows', () => {
    const first = run(undefined, 0, 10, 10);
    const later = run(first.state, 2 * W, 10, 10);
    expect(later.results.every((r) => r.allowed)).toBe(true);
  });

  it('honours cost', () => {
    const a = slidingWindow(undefined, 0, params(10, 7));
    expect(a.result).toMatchObject({ allowed: true, remaining: 3 });
    const b = slidingWindow(a.state, 0, params(10, 4));
    expect(b.result).toMatchObject({ allowed: false, remaining: 3 });
    const c = slidingWindow(b.state, 0, params(10, 3));
    expect(c.result).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('does not change counters on a denied request', () => {
    const full = run(undefined, 0, 10, 10);
    const denied = slidingWindow(full.state, 10, params(10));
    expect(denied.result.allowed).toBe(false);
    expect(denied.state).toEqual(full.state);
  });

  it('reports resetMs as time left in the current window', () => {
    expect(slidingWindow(undefined, 250, params(10)).result.resetMs).toBe(750);
  });

  it('retryAfterMs is the exact minimal wait (randomised)', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

    for (let trial = 0; trial < 2000; trial++) {
      const limit = 1 + Math.floor(rand() * 20);
      let state: SlidingWindowState | undefined;
      let now = Math.floor(rand() * 5000);

      for (let step = 0; step < 50; step++) {
        now += Math.floor(rand() * 300);
        const cost = 1 + Math.floor(rand() * limit);
        const out = slidingWindow(state, now, params(limit, cost));
        state = out.state;
        if (out.result.allowed) continue;

        const r = out.result.retryAfterMs;
        expect(r).toBeGreaterThan(0);
        expect(slidingWindow(state, now + r, params(limit, cost)).result.allowed).toBe(true);
        if (r > 1) {
          expect(slidingWindow(state, now + r - 1, params(limit, cost)).result.allowed).toBe(false);
        }
      }
    }
  });
});

describe('clock stepping back', () => {
  it('keeps counting in the stored window instead of starting over', () => {
    const W = 60_000;
    const params = { limit: 5, windowMs: W, cost: 1 };
    let state: SlidingWindowState | undefined;
    let now = 1000 * W + 59_000;
    let allowed = 0;
    const hit = () => {
      const out = slidingWindow(state, now, params);
      state = out.state;
      allowed += Number(out.result.allowed);
      return out;
    };
    for (let i = 0; i < 3; i++) hit();
    now += 2_000; // next window: 3 * 58/60 still counts, so 2 more fit
    for (let i = 0; i < 3; i++) hit();
    expect(allowed).toBe(5);
    expect(state!.window).toBe(1001);
    now -= 2_000; // stepped back into the previous window
    for (let i = 0; i < 10; i++) hit();
    expect(allowed).toBe(5); // without the fix: counters reset, 5 more pass
    expect(state!.window).toBe(1001);
  });
});

describe('state written by a clock that was ahead', () => {
  it('is discarded when more than a window ahead, so the key is not locked out', () => {
    const W = 60_000;
    const params = { limit: 5, windowMs: W, cost: 1 };
    const now = 1000 * W;
    let state: SlidingWindowState | undefined;
    for (let i = 0; i < 5; i++) state = slidingWindow(state, now + 6 * 3_600_000, params).state;
    const out = slidingWindow(state, now + 30_000, params);
    expect(out.result.allowed).toBe(true);
    expect(out.state.window).toBe(1000);
  });

  it('still counts in a stored window just one ahead', () => {
    const W = 60_000;
    const params = { limit: 5, windowMs: W, cost: 1 };
    let state: SlidingWindowState | undefined;
    for (let i = 0; i < 5; i++) state = slidingWindow(state, 1001 * W, params).state;
    expect(slidingWindow(state, 1001 * W - 1_000, params).result.allowed).toBe(false);
  });
});
