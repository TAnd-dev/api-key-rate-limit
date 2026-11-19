import { describe, expect, it } from 'vitest';
import { createLimiter, MemoryStore, type ConsumeRequest, type KeyCheck, type Store } from '../src/index.js';
import { withRateLimit, type FetchLimiterOptions } from '../src/fetch.js';

const mem = () => new MemoryStore({ cleanupIntervalMs: 0 });

describe('per-key limit in the core', () => {
  it.each(['sliding-window', 'token-bucket'] as const)('%s: overrides the default limit', async (algorithm) => {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000, algorithm });
    // Sequential: key hashing is async, so concurrent calls reach the store in any order.
    const pro = [];
    for (let i = 0; i < 6; i++) pro.push(await limiter.consume('pro', { limit: 5 }));
    expect(pro.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(pro[0]).toMatchObject({ limit: 5, remaining: 4 });

    const free = await Promise.all(Array.from({ length: 3 }, () => limiter.consume('free')));
    expect(free.filter((r) => r.allowed)).toHaveLength(2);
  });

  it('token-bucket refund caps at the per-key limit', async () => {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000, algorithm: 'token-bucket' });
    await limiter.consume('k', { limit: 5 });
    await limiter.refund('k', { limit: 5, cost: 5 });
    const results = await Promise.all(Array.from({ length: 6 }, () => limiter.consume('k', { limit: 5 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('validates the override', async () => {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000 });
    await expect(limiter.consume('k', { limit: 0 })).rejects.toThrow(RangeError);
    await expect(limiter.consume('k', { limit: 1.5 })).rejects.toThrow(RangeError);
    await expect(limiter.consume('k', { limit: 3, cost: 4 })).rejects.toThrow(/exceeds limit \(3\)/);
    // A higher per-key limit allows a cost above the default.
    await expect(limiter.consume('k', { limit: 10, cost: 4 })).resolves.toMatchObject({ allowed: true });
  });

  it('scales the fallback limit by the same ratio', async () => {
    const failing: Store = { consume: () => Promise.reject(new Error('down')), reset: async () => {} };
    const limiter = createLimiter({
      store: failing,
      limit: 100,
      windowMs: 60_000,
      fallback: { store: mem(), limit: 25 },
      onError: () => {},
    });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await limiter.consume('k', { limit: 8 }));
    expect(results.map((r) => [r.allowed, r.limit])).toEqual([
      [true, 2],
      [true, 2],
      [false, 2],
    ]);
  });

  it('fail-open reports the per-key limit', async () => {
    const failing: Store = { consume: () => Promise.reject(new Error('down')), reset: async () => {} };
    const limiter = createLimiter({ store: failing, limit: 2, windowMs: 1000, fallback: false, onError: () => {} });
    expect(await limiter.consume('k', { limit: 7 })).toMatchObject({ limit: 7, remaining: 7, degraded: 'fail-open' });
  });

  it('passes the limit through to the store', async () => {
    const seen: number[] = [];
    const store: Store = {
      consume: async (r: ConsumeRequest) => {
        seen.push(r.limit);
        return { allowed: true, limit: r.limit, remaining: 0, resetMs: 0, retryAfterMs: 0 };
      },
      reset: async () => {},
    };
    const limiter = createLimiter({ store, limit: 2, windowMs: 1000 });
    await limiter.consume('a');
    await limiter.consume('b', { limit: 9 });
    expect(seen).toEqual([2, 9]);
  });
});

const PLANS: Record<string, KeyCheck> = {
  'free-key': true, // default limit
  'pro-key': { limit: 4 },
  'revoked-key': false,
};

function setup(options: FetchLimiterOptions = {}, algorithm: 'sliding-window' | 'token-bucket' = 'sliding-window') {
  const lookups: string[] = [];
  const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000, algorithm });
  const handler = withRateLimit(
    limiter,
    (req) => new Response(null, { status: new URL(req.url).pathname === '/fail' ? 500 : 200 }),
    {
      validateKey: async (key) => {
        lookups.push(key);
        await new Promise((r) => setTimeout(r, 5)); // a "database"
        return PLANS[key];
      },
      ...options,
    },
  );
  const call = (key: string, path = '/') => handler(new Request(`http://x${path}`, { headers: { 'x-api-key': key } }));
  return { call, lookups };
}

describe('plans via validateKey', () => {
  it('applies the limit returned for each key', async () => {
    const { call } = setup();
    const pro = [];
    for (let i = 0; i < 5; i++) pro.push(await call('pro-key'));
    expect(pro.map((r) => r.status)).toEqual([200, 200, 200, 200, 429]);
    expect(pro[0]!.headers.get('ratelimit-limit')).toBe('4');

    const free = [];
    for (let i = 0; i < 3; i++) free.push((await call('free-key')).status);
    expect(free).toEqual([200, 200, 429]);

    expect((await call('revoked-key')).status).toBe(401);
    expect((await call('unknown-key')).status).toBe(401);
  });

  it('refunds failed requests against the key limit', async () => {
    const { call } = setup({ skipFailedRequests: true }, 'token-bucket');
    for (let i = 0; i < 6; i++) expect((await call('pro-key', '/fail')).status).toBe(500);
    await new Promise((r) => setTimeout(r, 10));
    const ok = [];
    for (let i = 0; i < 5; i++) ok.push((await call('pro-key')).status);
    expect(ok).toEqual([200, 200, 200, 200, 429]);
  });
});

describe('cacheValidation', () => {
  it('without it, every request is looked up', async () => {
    const { call, lookups } = setup();
    await call('pro-key');
    await call('pro-key');
    expect(lookups).toEqual(['pro-key', 'pro-key']);
  });

  it('caches valid keys, merges concurrent lookups, does not cache invalid ones', async () => {
    const { call, lookups } = setup({ cacheValidation: { ttlMs: 60_000 } });
    await Promise.all(Array.from({ length: 4 }, () => call('pro-key')));
    expect(lookups).toEqual(['pro-key']);
    await call('pro-key');
    expect(lookups).toEqual(['pro-key']);

    await call('unknown-key');
    await call('unknown-key');
    expect(lookups.filter((k) => k === 'unknown-key')).toHaveLength(2);
  });

  it('re-validates after ttlMs (a revoked key stops working)', async () => {
    const plans = { key: true as KeyCheck };
    const limiter = createLimiter({ store: mem(), limit: 100, windowMs: 60_000 });
    const handler = withRateLimit(limiter, () => new Response('ok'), {
      validateKey: (key) => plans[key as 'key'],
      cacheValidation: { ttlMs: 30 },
    });
    const call = () => handler(new Request('http://x/', { headers: { 'x-api-key': 'key' } })).then((r) => r.status);

    expect(await call()).toBe(200);
    plans.key = false;
    expect(await call()).toBe(200); // still cached
    await new Promise((r) => setTimeout(r, 40));
    expect(await call()).toBe(401);
  });

  it('evicts the least recently used entry beyond maxEntries', async () => {
    const { call, lookups } = setup({ cacheValidation: { ttlMs: 60_000, maxEntries: 1 } });
    await call('pro-key');
    await call('free-key'); // evicts pro-key
    await call('pro-key');
    expect(lookups).toEqual(['pro-key', 'free-key', 'pro-key']);
  });

  it('validates options', () => {
    expect(() => setup({ cacheValidation: { ttlMs: 0 } })).toThrow(RangeError);
    expect(() => setup({ cacheValidation: { ttlMs: 1, maxEntries: 0 } })).toThrow(RangeError);
  });
});

describe('cost above the plan limit', () => {
  function setup(anonymousLimit?: number) {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000 });
    const anonymous =
      anonymousLimit === undefined
        ? undefined
        : createLimiter({ store: mem(), limit: anonymousLimit, windowMs: 60_000, prefix: 'anon' });
    const handler = withRateLimit(limiter, () => new Response('ok'), {
      validateKey: (key) => PLANS[key],
      cost: (req) => Number(new URL(req.url).searchParams.get('cost') ?? 1),
      getIp: () => '192.0.2.1',
      ...(anonymous ? { anonymous } : {}),
    });
    return (cost: number, key?: string) =>
      handler(new Request(`http://x/?cost=${cost}`, { headers: key ? { 'x-api-key': key } : {} }));
  }

  it('answers 403 plan_limit_exceeded instead of throwing', async () => {
    const call = setup();
    const res = await call(3, 'free-key'); // free limit 2
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'plan_limit_exceeded',
      message: 'This endpoint is not available on your plan',
    });
    // The same request fits the pro plan (limit 4).
    expect((await call(3, 'pro-key')).status).toBe(200);
  });

  it('does not count the rejected request', async () => {
    const call = setup();
    await call(3, 'free-key');
    expect((await call(2, 'free-key')).status).toBe(200);
  });

  it('answers 401 missing_api_key for anonymous requests above the anonymous limit', async () => {
    const call = setup(1);
    expect((await call(1)).status).toBe(200);
    const res = await call(2);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_api_key' });
  });
});
