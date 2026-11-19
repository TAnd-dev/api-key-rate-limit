import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLimiter,
  MemoryStore,
  StoreTimeoutError,
  StoreUnavailableError,
  type ConsumeRequest,
  type LimiterOptions,
  type Store,
} from '../src/index.js';
import { withTimeout } from '../src/core/resilience.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A store whose behaviour can be switched at runtime and that counts calls. */
function flaky() {
  const inner = new MemoryStore({ cleanupIntervalMs: 0 });
  const s = {
    mode: 'ok' as 'ok' | 'fail' | 'hang',
    calls: 0,
    async consume(r: ConsumeRequest) {
      s.calls++;
      if (s.mode === 'fail') throw new Error('primary down');
      if (s.mode === 'hang') return new Promise<never>(() => {});
      return inner.consume(r);
    },
    async refund(r: ConsumeRequest) {
      s.calls++;
      if (s.mode === 'fail') throw new Error('primary down');
      return inner.refund(r);
    },
    reset: (key: string) => inner.reset(key),
  };
  return s satisfies Store;
}

// hashKeys: false: Web Crypto hashing is async on a thread pool and does not
// mix with fake timers. Hashing itself is covered in limiter.test.ts.
// fallback: false, so the policies are reached; the default fallback has its own tests.
function limiter(store: Store, extra: Partial<LimiterOptions> = {}) {
  return createLimiter({ store, limit: 2, windowMs: 60_000, hashKeys: false, fallback: false, onError: () => {}, ...extra });
}

describe('withTimeout', () => {
  it('rejects with StoreTimeoutError and clears its timer on success', async () => {
    vi.useFakeTimers();
    const slow = withTimeout(new Promise(() => {}), 100);
    vi.advanceTimersByTime(100);
    await expect(slow).rejects.toBeInstanceOf(StoreTimeoutError);

    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('store error policies', () => {
  it('fail-open (default) allows and marks the result', async () => {
    const store = flaky();
    store.mode = 'fail';
    const errors: unknown[] = [];
    const l = limiter(store, { onError: (e, info) => errors.push([(e as Error).message, info]) });
    expect(await l.consume('k')).toMatchObject({ allowed: true, remaining: 2, degraded: 'fail-open' });
    expect(errors).toEqual([['primary down', { operation: 'consume', store: 'primary', keyId: 'k' }]]);
  });

  it('fail-closed denies with a short Retry-After', async () => {
    const store = flaky();
    store.mode = 'fail';
    const r = await limiter(store, { onStoreError: 'fail-closed' }).consume('k');
    expect(r).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 1000, degraded: 'fail-closed' });
  });

  it('throw rejects with the store error', async () => {
    const store = flaky();
    store.mode = 'fail';
    await expect(limiter(store, { onStoreError: 'throw' }).consume('k')).rejects.toThrow('primary down');
  });

  it('times out a hanging store', async () => {
    vi.useFakeTimers();
    const store = flaky();
    store.mode = 'hang';
    const pending = limiter(store, { timeoutMs: 200 }).consume('k');
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ allowed: true, degraded: 'fail-open' });
  });

  it('validation errors are not store errors', async () => {
    const l = limiter(flaky());
    await expect(l.consume('k', { cost: 3 })).rejects.toThrow(RangeError);
  });

  it('never passes the raw key to onError when hashing', async () => {
    const store = flaky();
    store.mode = 'fail';
    const ids: string[] = [];
    await limiter(store, { hashKeys: true, onError: (_e, info) => ids.push(info.keyId) }).consume('sk_live_secret');
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toContain('sk_live_secret');
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a throwing onError hook does not break limiting', async () => {
    const store = flaky();
    store.mode = 'fail';
    const l = limiter(store, {
      onError: () => {
        throw new Error('hook bug');
      },
    });
    expect((await l.consume('k')).allowed).toBe(true);
  });

  it('validates options', () => {
    const store = flaky();
    expect(() => limiter(store, { timeoutMs: 0 })).toThrow(RangeError);
    // @ts-expect-error unknown policy
    expect(() => limiter(store, { onStoreError: 'ignore' })).toThrow(TypeError);
    expect(() => limiter(store, { fallback: { store, limit: 0 } })).toThrow(RangeError);
  });
});

describe('fallback store', () => {
  it('counts in the fallback with its own limit while the primary is down', async () => {
    const primary = flaky();
    const l = limiter(primary, { limit: 4, fallback: { store: new MemoryStore({ cleanupIntervalMs: 0 }), limit: 2 } });
    primary.mode = 'fail';
    const results = await Promise.all([1, 2, 3].map(() => l.consume('k')));
    expect(results.map((r) => [r.allowed, r.limit, r.degraded])).toEqual([
      [true, 2, 'fallback'],
      [true, 2, 'fallback'],
      [false, 2, 'fallback'],
    ]);
  });

  it('denies a cost that cannot fit the fallback limit without touching it', async () => {
    const primary = flaky();
    primary.mode = 'fail';
    const fb = flaky();
    const l = limiter(primary, { limit: 4, fallback: { store: fb, limit: 2 } });
    expect(await l.consume('k', { cost: 3 })).toMatchObject({ allowed: false, degraded: 'fallback' });
    expect(fb.calls).toBe(0);
  });

  it('falls through to the policy when the fallback fails too', async () => {
    const primary = flaky();
    const fb = flaky();
    primary.mode = fb.mode = 'fail';
    const info: unknown[] = [];
    const l = limiter(primary, { fallback: { store: fb }, onStoreError: 'fail-closed', onError: (_e, i) => info.push(i.store) });
    expect(await l.consume('k')).toMatchObject({ allowed: false, degraded: 'fail-closed' });
    expect(info).toEqual(['primary', 'fallback']);
  });

  it('refunds into the fallback when the primary is down', async () => {
    const primary = flaky();
    const fbStore = new MemoryStore({ cleanupIntervalMs: 0 });
    const l = limiter(primary, { fallback: { store: fbStore }, circuitBreaker: false });
    primary.mode = 'fail';
    await l.consume('k');
    await l.consume('k');
    expect((await l.consume('k')).allowed).toBe(false);
    await l.refund('k');
    expect(await l.consume('k')).toMatchObject({ allowed: true, degraded: 'fallback' });
  });

  it('refund swallows errors unless the policy is throw', async () => {
    const primary = flaky();
    primary.mode = 'fail';
    await expect(limiter(primary).refund('k')).resolves.toBeUndefined();
    await expect(limiter(primary, { onStoreError: 'throw', prefix: 'other' }).refund('k')).rejects.toThrow('primary down');
  });

  it('reset clears both stores', async () => {
    const primary = flaky();
    const fbStore = new MemoryStore({ cleanupIntervalMs: 0 });
    const l = limiter(primary, { limit: 1, fallback: { store: fbStore }, circuitBreaker: false });
    await l.consume('k');
    primary.mode = 'fail';
    await l.consume('k');
    primary.mode = 'ok';
    await l.reset('k');
    expect((await l.consume('k')).allowed).toBe(true);
    primary.mode = 'fail';
    expect((await l.consume('k')).allowed).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('stops calling a failing store, probes after the cooldown, closes on success', async () => {
    vi.useFakeTimers();
    const primary = flaky();
    primary.mode = 'fail';
    const l = limiter(primary, { circuitBreaker: { failureThreshold: 3, cooldownMs: 1000 } });

    for (let i = 0; i < 10; i++) await l.consume('k');
    expect(primary.calls).toBe(3); // then the circuit opened

    vi.advanceTimersByTime(1000);
    await l.consume('k'); // failed probe re-opens the circuit
    await l.consume('k');
    expect(primary.calls).toBe(4);

    vi.advanceTimersByTime(1000);
    primary.mode = 'ok';
    expect((await l.consume('k')).degraded).toBeUndefined(); // probe succeeds
    expect((await l.consume('k')).degraded).toBeUndefined();
    expect(primary.calls).toBe(6);
  });

  it('lets a single probe through when half-open', async () => {
    vi.useFakeTimers();
    const primary = flaky();
    primary.mode = 'fail';
    const l = limiter(primary, { circuitBreaker: { failureThreshold: 1, cooldownMs: 1000 } });
    await l.consume('k');
    vi.advanceTimersByTime(1000);
    primary.mode = 'hang';
    const probes = Array.from({ length: 5 }, () => l.consume('k'));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(probes);
    expect(primary.calls).toBe(2);
  });

  it('throw policy reports an open circuit as StoreUnavailableError', async () => {
    const primary = flaky();
    primary.mode = 'fail';
    const l = limiter(primary, { onStoreError: 'throw', circuitBreaker: { failureThreshold: 1 } });
    await expect(l.consume('k')).rejects.toThrow('primary down');
    await expect(l.consume('k')).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe('hung probes', () => {
  it('a probe that never answers does not keep the circuit half-open forever', async () => {
    vi.useFakeTimers();
    const primary = flaky();
    primary.mode = 'fail';
    const l = limiter(primary, {
      timeoutMs: Infinity,
      fallback: { store: new MemoryStore({ cleanupIntervalMs: 0 }) },
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1000 },
    });
    await l.consume('k'); // opens the circuit
    vi.advanceTimersByTime(1000);
    primary.mode = 'hang';
    void l.consume('k'); // the probe hangs, with no timeout to end it
    await vi.advanceTimersByTimeAsync(0);
    expect(primary.calls).toBe(2);

    primary.mode = 'ok';
    expect((await l.consume('k')).degraded).toBe('fallback'); // probe slot still held
    vi.advanceTimersByTime(1000);
    expect((await l.consume('k')).degraded).toBeUndefined(); // a new probe goes through
    expect(primary.calls).toBe(3);
  });
});

describe('default fallback', () => {
  const down = (): Store => ({ consume: () => Promise.reject(new Error('down')), reset: async () => {} });

  it('limits per instance in memory when the primary fails', async () => {
    const l = createLimiter({ store: down(), limit: 2, windowMs: 60_000, onError: () => {} });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await l.consume('k'));
    expect(results.map((r) => [r.allowed, r.degraded])).toEqual([
      [true, 'fallback'],
      [true, 'fallback'],
      [false, 'fallback'],
    ]);
  });

  it('fallback: false goes straight to the policy', async () => {
    const l = createLimiter({ store: down(), limit: 2, windowMs: 60_000, fallback: false, onError: () => {} });
    expect(await l.consume('k')).toMatchObject({ allowed: true, degraded: 'fail-open' });
  });
});
