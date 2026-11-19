import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createLimiter, MemoryStore, type LimiterOptions } from '../src/index.js';
import { expressLimiter, type ExpressLimiterOptions, type ExpressRequestLike, type ExpressResponseLike } from '../src/express.js';

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((done) => {
      if (!server) return done();
      server.closeAllConnections();
      server.close(() => done());
      server = undefined;
    }),
);

async function start(
  options: ExpressLimiterOptions<ExpressRequestLike, ExpressResponseLike> = {},
  limiterOptions: Partial<LimiterOptions> = {},
) {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const limiter = createLimiter({ store, limit: 2, windowMs: 60_000, ...limiterOptions });
  const app = express();
  // Must type-check against the real @types/express.
  app.use(expressLimiter(limiter, options));
  app.get('/ok', (_req, res) => {
    res.json({ rateLimit: res.locals.rateLimit });
  });
  app.get('/fail', (_req, res) => {
    res.status(500).send('boom');
  });
  server = app.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, headers: Record<string, string> = { 'x-api-key': 'k1' }) =>
    fetch(base + path, { headers });
}

describe('expressLimiter', () => {
  it('allows up to the limit, then answers 429 with Retry-After', async () => {
    const get = await start();
    const first = await get('/ok');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(((await first.json()) as { rateLimit: unknown }).rateLimit).toMatchObject({ allowed: true, remaining: 1 });

    expect((await get('/ok')).status).toBe(200);
    const limited = await get('/ok');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: 'too_many_requests' });

    // Other keys are unaffected.
    expect((await get('/ok', { authorization: 'Bearer k2' })).status).toBe(200);
  });

  it('rejects requests without a key', async () => {
    const get = await start();
    const res = await get('/ok', {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_api_key' });
  });

  it('lets requests without a key through with missingKey: skip', async () => {
    const get = await start({ missingKey: 'skip' });
    expect((await get('/ok', {})).status).toBe(200);
  });

  it('honours skip and cost (typed with real Express types)', async () => {
    const options: ExpressLimiterOptions<express.Request, express.Response> = {
      skip: (req) => req.path === '/fail',
      cost: (req) => (req.query.heavy ? 2 : 1),
    };
    // Type-level check: typed middleware is accepted by app.use / route handlers.
    express().get('/x', expressLimiter<express.Request, express.Response>(createLimiter({
      store: new MemoryStore({ cleanupIntervalMs: 0 }), limit: 1, windowMs: 1,
    }), options));
    const get = await start(options as ExpressLimiterOptions<ExpressRequestLike, ExpressResponseLike>);
    for (let i = 0; i < 5; i++) expect((await get('/fail')).status).toBe(500);
    expect((await get('/ok?heavy=1')).status).toBe(200);
    expect((await get('/ok')).status).toBe(429);
  });

  it('refunds failed requests with skipFailedRequests', async () => {
    const get = await start({ skipFailedRequests: true });
    for (let i = 0; i < 5; i++) expect((await get('/fail')).status).toBe(500);
    await new Promise((r) => setTimeout(r, 10)); // refunds run after 'finish'
    expect((await get('/ok')).status).toBe(200);
    expect((await get('/ok')).status).toBe(200);
    expect((await get('/ok')).status).toBe(429);
  });

  it('counts failed requests by default', async () => {
    const get = await start();
    await get('/fail');
    await get('/fail');
    expect((await get('/ok')).status).toBe(429);
  });

  it('supports custom 429 responses and header styles', async () => {
    const get = await start({
      headers: 'legacy',
      onLimited: (_req, res) => {
        (res as unknown as express.Response).status(429).type('text').send('slow down');
      },
    }, { limit: 1 });
    expect((await get('/ok')).headers.get('x-ratelimit-limit')).toBe('1');
    const limited = await get('/ok');
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('slow down');
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(limited.headers.get('ratelimit-limit')).toBeNull();
  });

  it('passes store errors to the Express error handler', async () => {
    const limiter = createLimiter({
      store: { consume: () => Promise.reject(new Error('store down')), reset: async () => {} },
      limit: 1,
      windowMs: 1000,
      onStoreError: 'throw',
      fallback: false,
      onError: () => {},
    });
    const app = express();
    app.use(expressLimiter(limiter));
    app.get('/ok', (_req, res) => {
      res.send('ok');
    });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(503).send(err.message);
    });
    server = app.listen(0);
    await new Promise((r) => server!.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`, {
      headers: { 'x-api-key': 'k' },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('store down');
  });
});
