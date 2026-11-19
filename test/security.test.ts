import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { apiKeyBucket, createLimiter, MemoryStore, normalizeIp, type ConsumeRequest, type Limiter } from '../src/index.js';
import { createRequestChecker, withRateLimit, type FetchLimiterOptions } from '../src/fetch.js';
import { expressLimiter } from '../src/express.js';

const mem = () => new MemoryStore({ cleanupIntervalMs: 0 });

describe('normalizeIp', () => {
  it.each([
    ['1.2.3.4', '1.2.3.4'],
    [' 1.2.3.4 ', '1.2.3.4'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:102:304', '1.2.3.4'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:0:0:0:0:0/56'],
    ['2001:db8:1:2ff::99', '2001:db8:1:200:0:0:0:0/56'],
    ['[2001:db8:1:2::1]', '2001:db8:1:0:0:0:0:0/56'],
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:0/56'],
    ['::1', '0:0:0:0:0:0:0:0/56'],
    ['not-an-ip', 'not-an-ip'],
    ['1:2:3', '1:2:3'],
    ['1::2::3', '1::2::3'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it('supports other subnet sizes', () => {
    expect(normalizeIp('2001:db8:abcd:1234::1', 64)).toBe('2001:db8:abcd:1234:0:0:0:0/64');
    expect(normalizeIp('2001:db8:abcd:1234::1', 48)).toBe('2001:db8:abcd:0:0:0:0:0/48');
    expect(normalizeIp('2001:db8:abcd:1234::1', 56)).toBe('2001:db8:abcd:1200:0:0:0:0/56');
    expect(normalizeIp('2001:db8::1', 128)).toBe('2001:db8:0:0:0:0:0:1/128');
  });
});

/** Fetch-adapter harness: the client IP comes from a test header. */
function harness(options: FetchLimiterOptions, limit = 5) {
  const calls: string[] = [];
  const store = mem();
  const spy = {
    consume: (r: ConsumeRequest) => {
      calls.push(r.key);
      return store.consume(r);
    },
    reset: (k: string) => store.reset(k),
  };
  const limiter = createLimiter({ store: spy, limit, windowMs: 60_000 });
  const handler = withRateLimit(limiter, () => new Response('ok'), {
    getIp: (req) => req.headers.get('x-test-ip') ?? undefined,
    ...options,
  });
  const call = (headers: Record<string, string>) => handler(new Request('http://x/', { headers }));
  return { call, calls };
}

const VALID = new Set(['good-key', 'other-good-key']);

describe('validateKey', () => {
  it('answers 401 for invalid keys without touching the store', async () => {
    const validated: string[] = [];
    const { call, calls } = harness({
      validateKey: (key) => {
        validated.push(key);
        return VALID.has(key);
      },
    });
    const bad = await call({ 'x-api-key': 'random-123' });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'invalid_api_key' });
    expect(calls).toHaveLength(0);

    expect((await call({ 'x-api-key': 'good-key' })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(validated).toEqual(['random-123', 'good-key']);
  });

  it('rejects over-long keys without calling validateKey', async () => {
    let validated = 0;
    const { call } = harness({ validateKey: () => (validated++, true), maxKeyLength: 10 });
    expect((await call({ 'x-api-key': 'x'.repeat(11) })).status).toBe(401);
    expect(validated).toBe(0);
  });

  it('rejects over-long keys even without validateKey', async () => {
    const { call, calls } = harness({});
    expect((await call({ 'x-api-key': 'x'.repeat(257) })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('invalidKeys (per-IP limit on failed validations)', () => {
  function setup() {
    let validations = 0;
    const invalidKeys = createLimiter({ store: mem(), limit: 3, windowMs: 200, prefix: 'akl-invalid' });
    const h = harness({
      invalidKeys,
      validateKey: (key) => {
        validations++;
        return VALID.has(key);
      },
    });
    return { ...h, validations: () => validations };
  }

  it('blocks an IP after too many invalid keys, before validateKey is called', async () => {
    const { call, validations } = setup();
    const ip = { 'x-test-ip': '10.0.0.1' };
    for (let i = 0; i < 3; i++) expect((await call({ ...ip, 'x-api-key': `guess-${i}` })).status).toBe(401);

    const fourth = await call({ ...ip, 'x-api-key': 'guess-3' });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get('retry-after')).not.toBeNull();
    expect(validations()).toBe(4);

    // Blocked: even a valid key is not checked (and not let through) from this IP.
    expect((await call({ ...ip, 'x-api-key': 'good-key' })).status).toBe(429);
    expect(validations()).toBe(4);

    // Other IPs are unaffected.
    expect((await call({ 'x-test-ip': '10.0.0.2', 'x-api-key': 'good-key' })).status).toBe(200);
  });

  it('unblocks the IP once the window passes', async () => {
    const { call } = setup();
    const ip = { 'x-test-ip': '10.0.0.3' };
    for (let i = 0; i < 4; i++) await call({ ...ip, 'x-api-key': `guess-${i}` });
    expect((await call({ ...ip, 'x-api-key': 'good-key' })).status).toBe(429);
    // Worst case for a 200 ms sliding window with 3/3 used: the rest of the
    // current window plus a third of the next one, ~267 ms.
    await new Promise((r) => setTimeout(r, 320));
    expect((await call({ ...ip, 'x-api-key': 'good-key' })).status).toBe(200);
  });

  it('requires validateKey', () => {
    const invalidKeys = createLimiter({ store: mem(), limit: 1, windowMs: 1000 });
    expect(() => harness({ invalidKeys })).toThrow(/requires validateKey/);
  });
});

describe('anonymous (per-IP limit for requests without a key)', () => {
  function setup() {
    const anonymous: Limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000, prefix: 'akl-anon' });
    return harness({ anonymous });
  }

  it('counts keyless requests per IP and sends headers', async () => {
    const { call } = setup();
    const first = await call({ 'x-test-ip': '192.0.2.1' });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    await call({ 'x-test-ip': '192.0.2.1' });
    expect((await call({ 'x-test-ip': '192.0.2.1' })).status).toBe(429);
    expect((await call({ 'x-test-ip': '192.0.2.2' })).status).toBe(200);
    // Keyed requests use the main limiter.
    expect((await call({ 'x-test-ip': '192.0.2.1', 'x-api-key': 'k' })).status).toBe(200);
  });

  it('groups IPv6 clients by /56', async () => {
    const { call } = setup();
    // Different /64s inside one /56: one client.
    await call({ 'x-test-ip': '2001:db8:0:1::a' });
    await call({ 'x-test-ip': '2001:db8:0:2::b' });
    expect((await call({ 'x-test-ip': '2001:db8:0:ff:ffff::c' })).status).toBe(429);
    expect((await call({ 'x-test-ip': '2001:db8:0:100::a' })).status).toBe(200);
  });

  it('the Fetch adapter requires getIp', () => {
    const anonymous = createLimiter({ store: mem(), limit: 1, windowMs: 1000 });
    const limiter = createLimiter({ store: mem(), limit: 1, windowMs: 1000 });
    expect(() => createRequestChecker(limiter, { anonymous })).toThrow(/getIp is required/);
  });
});

describe('Express client IP', () => {
  async function serve(trustProxy: boolean) {
    const anonymous = createLimiter({ store: mem(), limit: 1, windowMs: 60_000 });
    const limiter = createLimiter({ store: mem(), limit: 1, windowMs: 60_000 });
    const app = express();
    app.set('trust proxy', trustProxy);
    app.use(expressLimiter(limiter, { anonymous }));
    app.get('/', (_req, res) => {
      res.send('ok');
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const get = (xff: string) => fetch(url, { headers: { 'x-forwarded-for': xff } }).then((r) => r.status);
    return { get, close: () => (server.closeAllConnections(), server.close()) };
  }

  it('ignores a spoofed X-Forwarded-For unless trust proxy is set', async () => {
    const direct = await serve(false);
    try {
      expect(await direct.get('203.0.113.1')).toBe(200);
      expect(await direct.get('203.0.113.2')).toBe(429); // same socket address
    } finally {
      direct.close();
    }

    const proxied = await serve(true);
    try {
      expect(await proxied.get('203.0.113.1')).toBe(200);
      expect(await proxied.get('203.0.113.2')).toBe(200);
    } finally {
      proxied.close();
    }
  });
});

describe('skipFailedRequests cannot be used to bypass the limit', () => {
  it('does not refund requests aborted by the client (Express)', async () => {
    const limiter = createLimiter({ store: mem(), limit: 3, windowMs: 60_000 });
    let executions = 0;
    const app = express();
    app.use(expressLimiter(limiter, { skipFailedRequests: true }));
    app.get('/slow', (_req, res) => {
      // Expensive work that runs whether or not the client is still there.
      setTimeout(() => {
        executions++;
        res.send('done');
      }, 40);
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
    try {
      for (let i = 0; i < 6; i++) {
        const ctrl = new AbortController();
        const pending = fetch(url, { headers: { 'x-api-key': 'k' }, signal: ctrl.signal }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
        ctrl.abort();
        await pending;
      }
      await new Promise((r) => setTimeout(r, 80));
      expect(executions).toBe(3);
      expect((await fetch(url, { headers: { 'x-api-key': 'k' } })).status).toBe(429);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('does not refund aborted requests (Fetch checker)', async () => {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000 });
    const check = createRequestChecker(limiter, { skipFailedRequests: true });
    const req = () => new Request('http://x/', { headers: { 'x-api-key': 'k' } });
    for (let i = 0; i < 2; i++) (await check(req())).settle();
    await new Promise((r) => setTimeout(r, 10));
    expect((await check(req())).response?.status).toBe(429);
  });

  function failing(status: number, options: FetchLimiterOptions = {}) {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000 });
    const handler = withRateLimit(limiter, () => new Response(null, { status }), { skipFailedRequests: true, ...options });
    return () => handler(new Request('http://x/', { headers: { 'x-api-key': 'k' } })).then((r) => r.status);
  }

  it('counts 4xx responses by default, so enumeration is not free', async () => {
    const call = failing(404);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(await call());
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(statuses).toEqual([404, 404, 429]);
  });

  it('refunds 5xx by default, and 4xx only with a custom isFailure', async () => {
    for (const call of [failing(503), failing(404, { isFailure: (s) => s >= 400 })]) {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(await call());
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(statuses).not.toContain(429);
    }
  });
});

describe('API keys and client IPs never share a counter', () => {
  const victim = { 'x-test-ip': '203.0.113.7' };
  const attack = { 'x-test-ip': '198.51.100.1', 'x-api-key': 'ip:203.0.113.7' };

  it('separate limiters on one store with the default prefix', async () => {
    const store = mem();
    const limiter = createLimiter({ store, limit: 5, windowMs: 60_000 });
    // Same namespace on the store would be refused; a different window is allowed.
    const anonymous = createLimiter({ store, limit: 2, windowMs: 30_000 });
    const handler = withRateLimit(limiter, () => new Response('ok'), {
      anonymous,
      getIp: (req) => req.headers.get('x-test-ip') ?? undefined,
    });
    const call = (headers: Record<string, string>) => handler(new Request('http://x/', { headers })).then((r) => r.status);
    for (let i = 0; i < 5; i++) await call(attack);
    expect(await call(victim)).toBe(200);
  });

  it('the same limiter for keys and anonymous requests', async () => {
    const limiter = createLimiter({ store: mem(), limit: 2, windowMs: 60_000 });
    const handler = withRateLimit(limiter, () => new Response('ok'), {
      anonymous: limiter,
      getIp: (req) => req.headers.get('x-test-ip') ?? undefined,
    });
    const call = (headers: Record<string, string>) => handler(new Request('http://x/', { headers })).then((r) => r.status);
    for (let i = 0; i < 3; i++) await call(attack);
    expect(await call(victim)).toBe(200);
  });

  it('apiKeyBucket resets a key counted by an adapter', async () => {
    const limiter = createLimiter({ store: mem(), limit: 1, windowMs: 60_000 });
    const handler = withRateLimit(limiter, () => new Response('ok'));
    const call = () => handler(new Request('http://x/', { headers: { 'x-api-key': 'k' } })).then((r) => r.status);
    expect(await call()).toBe(200);
    expect(await call()).toBe(429);
    await limiter.reset(apiKeyBucket('k'));
    expect(await call()).toBe(200);
  });
});

describe('limiters sharing a store', () => {
  it.each(['sliding-window', 'token-bucket'] as const)(
    '%s: per-minute and per-hour limiters keep separate counters',
    async (algorithm) => {
      const store = mem();
      const perMinute = createLimiter({ store, limit: 5, windowMs: 60_000, algorithm });
      const perHour = createLimiter({ store, limit: 20, windowMs: 3_600_000, algorithm });
      let passed = 0;
      for (let i = 0; i < 30; i++) {
        const [a, b] = [await perMinute.consume('k'), await perHour.consume('k')];
        if (a.allowed && b.allowed) passed++;
      }
      expect(passed).toBe(5);
    },
  );

  it('refuses a second limiter with the same namespace on the same store', () => {
    const store = mem();
    createLimiter({ store, limit: 10, windowMs: 60_000 });
    expect(() => createLimiter({ store, limit: 5, windowMs: 60_000 })).toThrow(/distinct `prefix`/);
    // A distinct prefix, window or algorithm is fine.
    createLimiter({ store, limit: 5, windowMs: 60_000, prefix: 'expensive' });
    createLimiter({ store, limit: 5, windowMs: 30_000 });
    createLimiter({ store, limit: 5, windowMs: 60_000, algorithm: 'token-bucket' });
  });

  it('checks a shared fallback store too', () => {
    const fallback = { store: mem() };
    createLimiter({ store: { consume: () => Promise.reject(new Error('x')), reset: async () => {} }, limit: 1, windowMs: 1000, fallback });
    const other = { consume: () => Promise.reject(new Error('x')), reset: async () => {} };
    expect(() => createLimiter({ store: other, limit: 1, windowMs: 1000, fallback })).toThrow(/distinct `prefix`/);
  });

  it('a failed option check does not take the namespace', () => {
    const store = mem();
    expect(() => createLimiter({ store, limit: 1, windowMs: 1000, hashKeys: { secret: '' } })).toThrow(RangeError);
    expect(() => createLimiter({ store, limit: 1, windowMs: 1000 })).not.toThrow();
  });
});

describe('MemoryStore after the clock was hours ahead', () => {
  it.each(['sliding-window', 'token-bucket'] as const)('%s: a retrying client is not locked out', async (algorithm) => {
    let now = 1_700_000_000_000;
    const limiter = createLimiter({ store: new MemoryStore({ clock: () => now, cleanupIntervalMs: 0 }), limit: 5, windowMs: 60_000, algorithm });
    now += 6 * 3_600_000; // wrong clock at boot
    for (let i = 0; i < 5; i++) await limiter.consume('k');
    now -= 6 * 3_600_000; // corrected by NTP
    now += 30_000;
    expect((await limiter.consume('k')).allowed).toBe(true);
  });
});

describe('withRateLimit with responses that cannot be rebuilt', () => {
  it('passes Response.error() through instead of throwing', async () => {
    const limiter = createLimiter({ store: mem(), limit: 5, windowMs: 60_000 });
    const handler = withRateLimit(limiter, () => Response.error());
    const res = await handler(new Request('http://x/', { headers: { 'x-api-key': 'k' } }));
    expect(res.type).toBe('error');
  });
});
