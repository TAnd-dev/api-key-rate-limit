import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createLimiter, MemoryStore, type ConsumeRequest, type LimiterOptions, type Store } from '../src/index.js';

function setup(limit = 5) {
  let now = 0;
  const store = new MemoryStore({ clock: () => now, cleanupIntervalMs: 0 });
  const limiter = createLimiter({ store, limit, windowMs: 1000 });
  return { limiter, store, tick: (ms: number) => (now += ms) };
}

describe('createLimiter', () => {
  it('limits per key and recovers after the window slides', async () => {
    const { limiter, tick } = setup(5);
    for (let i = 0; i < 5; i++) expect((await limiter.consume('k')).allowed).toBe(true);

    const denied = await limiter.consume('k');
    expect(denied).toMatchObject({ allowed: false, limit: 5, remaining: 0 });

    tick(denied.retryAfterMs);
    expect((await limiter.consume('k')).allowed).toBe(true);
  });

  it('prefixes storage keys so limiters can share a store', async () => {
    const seen: string[] = [];
    const store: Store = {
      async consume(r: ConsumeRequest) {
        seen.push(r.key);
        return { allowed: true, limit: r.limit, remaining: 0, resetMs: 0, retryAfterMs: 0 };
      },
      async reset() {},
    };
    await createLimiter({ store, limit: 1, windowMs: 1000, hashKeys: false }).consume('k');
    await createLimiter({ store, limit: 1, windowMs: 1000, hashKeys: false, prefix: 'other' }).consume('k');
    await createLimiter({ store, limit: 1, windowMs: 2000, hashKeys: false }).consume('k');
    await createLimiter({ store, limit: 1, windowMs: 1000, hashKeys: false, algorithm: 'token-bucket' }).consume('k');
    expect(seen).toEqual([
      'akl:sliding-window:1000:k',
      'other:sliding-window:1000:k',
      'akl:sliding-window:2000:k',
      'akl:token-bucket:1000:k',
    ]);
  });

  it('hashes keys by default: SHA-256, HMAC with a secret, or a custom function', async () => {
    const seen: string[] = [];
    // A store per limiter: one store refuses two limiters with the same namespace.
    const spy = (): Store => ({
      async consume(r: ConsumeRequest) {
        seen.push(r.key);
        return { allowed: true, limit: r.limit, remaining: 0, resetMs: 0, retryAfterMs: 0 };
      },
      async reset() {},
    });
    const make = (hashKeys?: LimiterOptions['hashKeys']) =>
      createLimiter({ store: spy(), limit: 1, windowMs: 1000, ...(hashKeys === undefined ? {} : { hashKeys }) });

    await make().consume('sk_live_abc');
    await make().consume('sk_live_abc');
    await make({ secret: 'pepper' }).consume('sk_live_abc');
    await make({ secret: 'other' }).consume('sk_live_abc');
    await make((k) => `custom-${k.length}`).consume('sk_live_abc');

    const sha = createHash('sha256').update('sk_live_abc').digest('base64url');
    const hmac = createHmac('sha256', 'pepper').update('sk_live_abc').digest('base64url');
    expect(seen).toEqual([
      `akl:sliding-window:1000:${sha}`,
      `akl:sliding-window:1000:${sha}`,
      `akl:sliding-window:1000:${hmac}`,
      expect.not.stringMatching(hmac),
      'akl:sliding-window:1000:custom-11',
    ]);
    expect(seen.join()).not.toContain('sk_live_abc');
    expect(() => make({ secret: '' })).toThrow(RangeError);
  });

  it('validates options', () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0 });
    expect(() => createLimiter({ store, limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => createLimiter({ store, limit: 1, windowMs: 1.5 })).toThrow(RangeError);
    expect(() =>
      // @ts-expect-error unknown algorithm
      createLimiter({ store, limit: 1, windowMs: 1000, algorithm: 'nope' }),
    ).toThrow(TypeError);
  });

  it('rejects (not throws) on bad consume arguments', async () => {
    const { limiter } = setup(5);
    await expect(limiter.consume('')).rejects.toThrow(TypeError);
    await expect(limiter.consume('k', { cost: 0 })).rejects.toThrow(RangeError);
    await expect(limiter.consume('k', { cost: 6 })).rejects.toThrow(/exceeds limit/);
  });

  it('serialises concurrent consumes correctly', async () => {
    const { limiter } = setup(100);
    const results = await Promise.all(Array.from({ length: 1000 }, () => limiter.consume('k')));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
  });
});

describe('createLimiter with token-bucket', () => {
  it('allows a burst, then holds to the refill rate', async () => {
    let now = 0;
    const store = new MemoryStore({ clock: () => now, cleanupIntervalMs: 0 });
    const limiter = createLimiter({ store, limit: 10, windowMs: 1000, algorithm: 'token-bucket' });

    const burst = await Promise.all(Array.from({ length: 15 }, () => limiter.consume('k')));
    expect(burst.filter((r) => r.allowed)).toHaveLength(10);

    now += 250; // 2.5 tokens refilled
    const next = await Promise.all(Array.from({ length: 5 }, () => limiter.consume('k')));
    expect(next.filter((r) => r.allowed)).toHaveLength(2);
  });

  it('keeps sliding-window and token-bucket state separate in one store', async () => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    const sw = createLimiter({ store, limit: 1, windowMs: 1000 });
    const tb = createLimiter({ store, limit: 1, windowMs: 1000, algorithm: 'token-bucket' });
    expect((await sw.consume('k')).allowed).toBe(true);
    expect((await tb.consume('k')).allowed).toBe(true);
  });
});

describe('refund', () => {
  it.each(['sliding-window', 'token-bucket'] as const)('%s: gives units back', async (algorithm) => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    const limiter = createLimiter({ store, limit: 3, windowMs: 1000, algorithm });
    await limiter.consume('k', { cost: 3 });
    expect((await limiter.consume('k')).allowed).toBe(false);
    await limiter.refund('k', { cost: 2 });
    expect(await limiter.consume('k')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it.each(['sliding-window', 'token-bucket'] as const)('%s: never exceeds the limit', async (algorithm) => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    const limiter = createLimiter({ store, limit: 3, windowMs: 1000, algorithm });
    await limiter.consume('k');
    await limiter.refund('k', { cost: 3 });
    await limiter.refund('k', { cost: 3 });
    const results = await Promise.all([1, 2, 3, 4].map(() => limiter.consume('k')));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('is a no-op for unknown keys and rejects for stores without refund', async () => {
    const { limiter } = setup(5);
    await expect(limiter.refund('never-seen')).resolves.toBeUndefined();

    const bare: Store = {
      consume: async (r) => ({ allowed: true, limit: r.limit, remaining: 0, resetMs: 0, retryAfterMs: 0 }),
      reset: async () => {},
    };
    await expect(createLimiter({ store: bare, limit: 1, windowMs: 1 }).refund('k')).rejects.toThrow(/refund/);
  });
});
