import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createLimiter, MemoryStore } from '../src/index.js';
import { fastifyLimiter, type FastifyLimiterOptions, type FastifyReplyLike, type FastifyRequestLike } from '../src/fastify.js';

function build(options: FastifyLimiterOptions<FastifyRequestLike, FastifyReplyLike> = {}, limit = 2) {
  const limiter = createLimiter({ store: new MemoryStore({ cleanupIntervalMs: 0 }), limit, windowMs: 60_000 });
  const app = Fastify();
  // Must type-check against real Fastify types.
  app.addHook('onRequest', fastifyLimiter(limiter, options));
  app.get('/ok', async () => ({ ok: true }));
  app.get('/fail', async (_req, reply) => reply.code(500).send('boom'));
  app.get('/heavy', { onRequest: fastifyLimiter(limiter, { cost: 2 }) }, async () => 'heavy');
  const get = (url: string, headers: Record<string, string> = { 'x-api-key': 'k1' }) =>
    app.inject({ method: 'GET', url, headers });
  return { app, get };
}

describe('fastifyLimiter', () => {
  it('allows up to the limit, then answers 429 with Retry-After', async () => {
    const { get } = build();
    const first = await get('/ok');
    expect(first.statusCode).toBe(200);
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect((await get('/ok')).statusCode).toBe(200);

    const limited = await get('/ok');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ error: 'too_many_requests' });
    expect((await get('/ok', { 'x-api-key': 'k2' })).statusCode).toBe(200);
  });

  it('rejects requests without a key', async () => {
    const { get } = build();
    const res = await get('/ok', {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'missing_api_key' });
  });

  it('per-route hooks stack with the global one', async () => {
    const { get } = build({}, 3);
    // Global hook costs 1, the route hook 2 more: 3 in total.
    expect((await get('/heavy')).statusCode).toBe(200);
    expect((await get('/ok')).statusCode).toBe(429);
  });

  it('refunds failed requests with skipFailedRequests', async () => {
    const { get } = build({ skipFailedRequests: true });
    for (let i = 0; i < 5; i++) expect((await get('/fail')).statusCode).toBe(500);
    await new Promise((r) => setTimeout(r, 10));
    expect((await get('/ok')).statusCode).toBe(200);
    expect((await get('/ok')).statusCode).toBe(200);
    expect((await get('/ok')).statusCode).toBe(429);
  });

  it('accepts typed callbacks with real Fastify types', async () => {
    const limiter = createLimiter({ store: new MemoryStore({ cleanupIntervalMs: 0 }), limit: 1, windowMs: 60_000 });
    const app = Fastify();
    app.addHook(
      'onRequest',
      fastifyLimiter<FastifyRequest, FastifyReply>(limiter, {
        skip: (req) => req.url === '/health',
        onLimited: (_req, reply) => reply.code(429).send({ custom: true }),
      }),
    );
    app.get('/health', async () => 'up');
    app.get('/ok', async () => 'ok');
    const get = (url: string) => app.inject({ url, headers: { 'x-api-key': 'k' } });
    for (let i = 0; i < 3; i++) expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/ok')).statusCode).toBe(200);
    expect((await get('/ok')).json()).toEqual({ custom: true });
  });

  it('supports a custom 429 response', async () => {
    const { get } = build({ onLimited: (_req, reply) => reply.code(429).send('slow down') }, 1);
    await get('/ok');
    const limited = await get('/ok');
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toBe('slow down');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('sends store errors to the Fastify error handler', async () => {
    const limiter = createLimiter({
      store: { consume: () => Promise.reject(new Error('store down')), reset: async () => {} },
      limit: 1,
      windowMs: 1000,
      onStoreError: 'throw',
      fallback: false,
      onError: () => {},
    });
    const app = Fastify();
    app.addHook('onRequest', fastifyLimiter(limiter));
    app.get('/ok', async () => 'ok');
    app.setErrorHandler((err, _req, reply) => reply.code(503).send((err as Error).message));
    const res = await app.inject({ url: '/ok', headers: { 'x-api-key': 'k' } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('store down');
  });
});
