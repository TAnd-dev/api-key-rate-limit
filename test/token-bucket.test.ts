import { describe, expect, it } from 'vitest';
import { tokenBucket, type TokenBucketState } from '../src/algorithms/token-bucket.js';

const W = 1000;
const params = (limit: number, cost = 1) => ({ limit, windowMs: W, cost });

function run(state: TokenBucketState | undefined, now: number, n: number, limit: number) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const out = tokenBucket(state, now, params(limit));
    state = out.state;
    results.push(out.result);
  }
  return { state, results };
}

describe('tokenBucket', () => {
  it('allows a burst of `limit` from a full bucket', () => {
    const { results } = run(undefined, 0, 11, 10);
    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10]!.allowed).toBe(false);
    expect(results.map((r) => r.remaining).slice(0, 10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('refills at limit / windowMs', () => {
    const empty = run(undefined, 0, 10, 10); // 1 token per 100 ms
    expect(tokenBucket(empty.state, 99, params(10)).result.allowed).toBe(false);
    expect(tokenBucket(empty.state, 100, params(10)).result.allowed).toBe(true);
    expect(run(empty.state, 550, 6, 10).results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('never refills above capacity', () => {
    const empty = run(undefined, 0, 10, 10);
    expect(run(empty.state, 10 * W, 11, 10).results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('a clock jumping backwards does not drain or refill the bucket', () => {
    const half = run(undefined, 1000, 5, 10);
    const back = tokenBucket(half.state, 0, params(10));
    expect(back.result).toMatchObject({ allowed: true, remaining: 4 });
  });

  it('reports resetMs as time until full and expires the state then', () => {
    const out = run(undefined, 0, 3, 10);
    const last = tokenBucket(out.state, 0, params(10));
    expect(last.result.resetMs).toBe(400);
    expect(last.expiresAt).toBe(400);
  });

  it('honours cost and does not consume on denial', () => {
    const a = tokenBucket(undefined, 0, params(10, 7));
    expect(a.result).toMatchObject({ allowed: true, remaining: 3 });
    const b = tokenBucket(a.state, 0, params(10, 4));
    expect(b.result).toMatchObject({ allowed: false, remaining: 3, retryAfterMs: 100 });
    expect(tokenBucket(b.state, 0, params(10, 3)).result).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('retryAfterMs is the exact minimal wait (randomised)', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

    for (let trial = 0; trial < 2000; trial++) {
      const limit = 1 + Math.floor(rand() * 20);
      const windowMs = 1 + Math.floor(rand() * 3000);
      let state: TokenBucketState | undefined;
      let now = Math.floor(rand() * 5000);

      for (let step = 0; step < 50; step++) {
        now += Math.floor(rand() * 200);
        const p = { limit, windowMs, cost: 1 + Math.floor(rand() * limit) };
        const out = tokenBucket(state, now, p);
        state = out.state;
        if (out.result.allowed) continue;

        const r = out.result.retryAfterMs;
        expect(r).toBeGreaterThan(0);
        expect(tokenBucket(state, now + r, p).result.allowed).toBe(true);
        if (r > 1) expect(tokenBucket(state, now + r - 1, p).result.allowed).toBe(false);
      }
    }
  });
});

describe('state written by a clock that was ahead', () => {
  const W = 60_000;
  const p = { limit: 5, windowMs: W, cost: 1 };

  it('is discarded when more than a window ahead', () => {
    let state: TokenBucketState | undefined;
    for (let i = 0; i < 5; i++) state = tokenBucket(state, 1e12 + 6 * 3_600_000, p).state;
    expect(tokenBucket(state, 1e12, p).result).toMatchObject({ allowed: true, remaining: 4 });
  });

  it('pauses the refill when less than a window ahead', () => {
    let state: TokenBucketState | undefined;
    for (let i = 0; i < 5; i++) state = tokenBucket(state, 1e12 + 30_000, p).state;
    expect(tokenBucket(state, 1e12, p).result.allowed).toBe(false);
    // Refill resumes once real time passes the stored time.
    expect(tokenBucket(state, 1e12 + 30_000 + W / 5, p).result.allowed).toBe(true);
  });
});
