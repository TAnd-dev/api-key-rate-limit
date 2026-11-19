// Runs the *built* package (dist/) without a test framework, so it also works
// on Node versions the dev tooling does not support (Node 20 in CI).
// Usage: npm run build && node scripts/smoke.mjs   (REDIS_URL enables Redis checks)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createLimiter, MemoryStore } from 'api-key-rate-limit';
import { withRateLimit } from 'api-key-rate-limit/fetch';

const require = createRequire(import.meta.url);

async function check(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

await check('ESM: memory store, both algorithms, hashed keys', async () => {
  for (const algorithm of ['sliding-window', 'token-bucket']) {
    const store = new MemoryStore();
    const limiter = createLimiter({ store, limit: 2, windowMs: 60_000, algorithm, hashKeys: { secret: 's' } });
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await limiter.consume('sk_test')).allowed);
    assert.deepEqual(results, [true, true, false]);
    await store.close();
  }
});

await check('CJS: all entry points load', async () => {
  for (const entry of ['', '/redis', '/express', '/fastify', '/fetch']) {
    const mod = require(`api-key-rate-limit${entry}`);
    assert.ok(Object.keys(mod).length > 0, `api-key-rate-limit${entry} exports nothing`);
  }
});

await check('Fetch adapter: headers, 429, 401, 403', async () => {
  const limiter = createLimiter({ store: new MemoryStore(), limit: 1, windowMs: 60_000 });
  const handler = withRateLimit(limiter, () => new Response('ok'), {
    validateKey: (key) => (key === 'pro' ? { limit: 3 } : key === 'free'),
    cost: (req) => Number(new URL(req.url).searchParams.get('cost') ?? 1),
  });
  const call = (key, cost = 1) =>
    handler(new Request(`http://x/?cost=${cost}`, { headers: key ? { 'x-api-key': key } : {} }));
  const first = await call('free');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-limit'), '1');
  assert.equal((await call('free')).status, 429);
  assert.equal((await call(undefined)).status, 401);
  assert.equal((await call('nope')).status, 401);
  assert.equal((await call('free', 2)).status, 403);
  assert.equal((await call('pro', 2)).status, 200);
});

if (process.env.REDIS_URL) {
  const { RedisStore } = await import('api-key-rate-limit/redis');
  const { Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL);
  try {
    await check('Redis store: exact limit under concurrency', async () => {
      const prefix = `akl-smoke-${process.pid}-${Date.now()}`;
      const limiter = createLimiter({ store: new RedisStore({ client }), limit: 50, windowMs: 60_000, prefix });
      const results = await Promise.all(Array.from({ length: 200 }, () => limiter.consume('k')));
      assert.equal(results.filter((r) => r.allowed).length, 50);
      const keys = await client.keys(`${prefix}:*`);
      assert.equal(keys.length, 1);
      assert.ok(!keys[0].includes(':k'), 'raw key stored in Redis');
      await client.del(...keys);
    });
  } finally {
    client.disconnect();
  }
} else {
  console.log('skip - Redis checks (REDIS_URL not set)');
}
