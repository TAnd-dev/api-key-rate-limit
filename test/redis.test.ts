import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refundAlgorithm, runAlgorithm, type AlgorithmState } from '../src/algorithms/index.js';
import { createLimiter, MemoryStore, type Algorithm } from '../src/index.js';
import { RedisStore, type IoredisLike, type NodeRedisLike } from '../src/redis.js';

const url = process.env.REDIS_URL;
// Unique per run; never FLUSHDB, REDIS_URL might point at a shared instance.
const ns = `akl-test:${randomUUID()}`;
const ALGOS: Algorithm[] = ['sliding-window', 'token-bucket'];

interface Clients {
  io: Redis;
  node: ReturnType<typeof createClient>;
}

describe.skipIf(!url)('RedisStore (needs REDIS_URL)', () => {
  const c = {} as Clients;

  beforeAll(async () => {
    c.io = new Redis(url!);
    c.node = createClient({ url: url! });
    await c.node.connect();
  });

  afterAll(async () => {
    const keys = await c.io.keys(`${ns}:*`);
    if (keys.length) await c.io.del(...keys);
    c.io.disconnect();
    await c.node.quit();
  });

  const clients = [
    ['ioredis', () => c.io as unknown as IoredisLike],
    ['node-redis', () => c.node as unknown as NodeRedisLike],
  ] as const;

  describe.each(clients)('with %s', (name, client) => {
    describe.each(ALGOS)('%s', (algorithm) => {
      const prefix = `${ns}:${name}`;

      it('matches the JS implementation exactly (randomised)', async () => {
        let seed = 99;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

        for (let trial = 0; trial < 60; trial++) {
          let now = 1_700_000_000_000 + Math.floor(rand() * 1e6);
          const store = new RedisStore({ client: client(), clock: () => now });
          const key = `${prefix}:parity:${algorithm}:${trial}`;
          const limit = 1 + Math.floor(rand() * 20);
          const windowMs = 1 + Math.floor(rand() * 3000);
          let jsState: AlgorithmState | undefined;

          for (let step = 0; step < 30; step++) {
            // Mostly forward; sometimes the clock steps back (NTP), up to two windows.
            now += rand() < 0.1 ? -Math.floor(rand() * 2 * windowMs) : Math.floor(rand() * 250);
            // Sometimes the key's plan changes between requests.
            const stepLimit = rand() < 0.3 ? 1 + Math.floor(rand() * 20) : limit;
            const params = { limit: stepLimit, windowMs, cost: 1 + Math.floor(rand() * stepLimit) };
            const js = runAlgorithm(algorithm, jsState, now, params);
            jsState = js.state;
            const lua = await store.consume({ key, algorithm, ...params });
            expect(lua, `trial ${trial} step ${step}`).toEqual(js.result);
          }
        }
      });

      it('refund matches the JS implementation', async () => {
        const now = 1_700_000_000_000;
        const store = new RedisStore({ client: client(), clock: () => now });
        const key = `${prefix}:refund:${algorithm}`;
        const params = { limit: 5, windowMs: 1000, cost: 2 };
        let js = runAlgorithm(algorithm, undefined, now, params).state;
        await store.consume({ key, algorithm, ...params });
        js = refundAlgorithm(js, { ...params, cost: 1 });
        await store.refund({ key, algorithm, ...params, cost: 1 });
        for (let i = 0; i < 6; i++) {
          const expected = runAlgorithm(algorithm, js, now, { ...params, cost: 1 });
          js = expected.state;
          expect(await store.consume({ key, algorithm, ...params, cost: 1 })).toEqual(expected.result);
        }
        // Refunding a missing key creates nothing.
        await store.refund({ key: `${key}:missing`, algorithm, ...params });
        expect(await c.io.exists(`${key}:missing`)).toBe(0);
      });

      it('keeps precision for large limit * windowMs', async () => {
        const now = 1_700_000_000_000;
        const store = new RedisStore({ client: client(), clock: () => now });
        const params = { limit: 1_000_000, windowMs: 2_000_000_000, cost: 1 };
        const key = `${prefix}:big:${algorithm}`;
        let js: AlgorithmState | undefined;
        for (let i = 0; i < 3; i++) {
          const expected = runAlgorithm(algorithm, js, now, params);
          js = expected.state;
          expect(await store.consume({ key, algorithm, ...params })).toEqual(expected.result);
        }
      });

      it('lets exactly `limit` of 1000 concurrent requests through', async () => {
        // Server clock; a long window so refill/sliding during the test is negligible.
        const limiter = createLimiter({
          store: new RedisStore({ client: client() }),
          limit: 100,
          windowMs: 3_600_000,
          algorithm,
          prefix,
        });
        const results = await Promise.all(Array.from({ length: 1000 }, () => limiter.consume('burst')));
        expect(results.filter((r) => r.allowed)).toHaveLength(100);
      });

      it('sets a TTL so idle keys disappear', async () => {
        const store = new RedisStore({ client: client() });
        const key = `${prefix}:ttl:${algorithm}`;
        await store.consume({ key, algorithm, limit: 5, windowMs: 10_000, cost: 1 });
        const ttl = await c.io.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(20_000);
      });

      it('recovers from an empty script cache (NOSCRIPT)', async () => {
        const store = new RedisStore({ client: client() });
        const key = `${prefix}:noscript:${algorithm}`;
        await c.io.script('FLUSH');
        const r = await store.consume({ key, algorithm, limit: 5, windowMs: 10_000, cost: 1 });
        expect(r).toMatchObject({ allowed: true, remaining: 4 });
      });

      it('reset deletes the key', async () => {
        const limiter = createLimiter({
          store: new RedisStore({ client: client() }),
          limit: 1,
          windowMs: 60_000,
          algorithm,
          prefix,
        });
        await limiter.consume('reset');
        expect((await limiter.consume('reset')).allowed).toBe(false);
        await limiter.reset('reset');
        expect((await limiter.consume('reset')).allowed).toBe(true);
      });
    });
  });

  it('shares limits between two different clients', async () => {
    const make = (client: IoredisLike | NodeRedisLike) =>
      createLimiter({ store: new RedisStore({ client }), limit: 2, windowMs: 60_000, prefix: `${ns}:shared` });
    const a = make(c.io);
    const b = make(c.node);
    expect((await a.consume('k')).allowed).toBe(true);
    expect((await b.consume('k')).allowed).toBe(true);
    expect((await a.consume('k')).allowed).toBe(false);
  });
});

describe('RedisStore without a server', () => {
  it('a dead Redis costs one timeout per breaker cycle, not one per request', async () => {
    // ioredis queues commands while it cannot connect: without a timeout they hang forever.
    const dead = new Redis({ port: 1, lazyConnect: false, maxRetriesPerRequest: null, retryStrategy: () => 50 });
    dead.on('error', () => {});
    try {
      const limiter = createLimiter({
        store: new RedisStore({ client: dead as unknown as IoredisLike }),
        limit: 2,
        windowMs: 60_000,
        timeoutMs: 150,
        fallback: { store: new MemoryStore({ cleanupIntervalMs: 0 }) },
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
        onError: () => {},
      });

      let t = performance.now();
      expect(await limiter.consume('k')).toMatchObject({ allowed: true, degraded: 'fallback' });
      await limiter.consume('k');
      expect(performance.now() - t).toBeGreaterThanOrEqual(290);

      // Circuit open: answered from the fallback without waiting.
      t = performance.now();
      expect(await limiter.consume('k')).toMatchObject({ allowed: false, degraded: 'fallback' });
      expect(performance.now() - t).toBeLessThan(50);
    } finally {
      dead.disconnect();
    }
  });

  it('rejects an unsupported client', () => {
    expect(() => new RedisStore({ client: {} as IoredisLike })).toThrow(/Unsupported Redis client/);
  });

  it('accepts a custom adapter and validates replies', async () => {
    const store = new RedisStore({
      adapter: {
        evalsha: async () => 'garbage',
        eval: async () => 'garbage',
        del: async () => 0,
      },
    });
    await expect(
      store.consume({ key: 'k', algorithm: 'sliding-window', limit: 1, windowMs: 1, cost: 1 }),
    ).rejects.toThrow(/Unexpected reply/);
  });

  it('falls back to EVAL only on NOSCRIPT', async () => {
    const calls: string[] = [];
    const store = new RedisStore({
      adapter: {
        evalsha: async () => {
          calls.push('evalsha');
          throw new Error('NOSCRIPT No matching script');
        },
        eval: async () => {
          calls.push('eval');
          return [1, 0, 10, 0];
        },
        del: async () => 0,
      },
    });
    await store.consume({ key: 'k', algorithm: 'token-bucket', limit: 1, windowMs: 10, cost: 1 });
    expect(calls).toEqual(['evalsha', 'eval']);

    const failing = new RedisStore({
      adapter: {
        evalsha: async () => {
          throw new Error('READONLY');
        },
        eval: async () => [1, 0, 0, 0],
        del: async () => 0,
      },
    });
    await expect(
      failing.consume({ key: 'k', algorithm: 'token-bucket', limit: 1, windowMs: 10, cost: 1 }),
    ).rejects.toThrow('READONLY');
  });
});
