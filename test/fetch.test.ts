import { describe, expect, it } from 'vitest';
import { createLimiter, MemoryStore } from '../src/index.js';
import { checkRequest, withRateLimit, type FetchLimiterOptions } from '../src/fetch.js';

function setup(options: FetchLimiterOptions = {}, limit = 2) {
  const limiter = createLimiter({ store: new MemoryStore({ cleanupIntervalMs: 0 }), limit, windowMs: 60_000 });
  const handler = withRateLimit(
    limiter,
    async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/fail') return new Response('boom', { status: 500 });
      if (path === '/throw') throw new Error('handler crashed');
      // fetch()-style immutable headers:
      if (path === '/redirect') return Response.redirect('http://example.com/', 302);
      return new Response('ok');
    },
    options,
  );
  const call = (path: string, headers: Record<string, string> = { 'x-api-key': 'k1' }) =>
    handler(new Request(`http://x${path}`, { headers }));
  return { limiter, call };
}

describe('withRateLimit', () => {
  it('adds headers, then answers 429', async () => {
    const { call } = setup();
    const first = await call('/ok');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('ok');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');

    await call('/ok');
    const limited = await call('/ok');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.json()).toMatchObject({ error: 'too_many_requests' });
  });

  it('copies responses with immutable headers', async () => {
    const { call } = setup();
    const res = await call('/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://example.com/');
    expect(res.headers.get('ratelimit-limit')).toBe('2');
  });

  it('answers 401 without a key', async () => {
    const { call } = setup();
    expect((await call('/ok', {})).status).toBe(401);
  });

  it('refunds failed and crashed requests with skipFailedRequests', async () => {
    const { call } = setup({ skipFailedRequests: true });
    for (let i = 0; i < 3; i++) expect((await call('/fail')).status).toBe(500);
    for (let i = 0; i < 3; i++) await expect(call('/throw')).rejects.toThrow('handler crashed');
    await new Promise((r) => setTimeout(r, 10));
    expect((await call('/ok')).status).toBe(200);
    expect((await call('/ok')).status).toBe(200);
    expect((await call('/ok')).status).toBe(429);
  });

  it('custom onLimited keeps rate limit headers', async () => {
    const { call } = setup({ onLimited: () => new Response('slow down', { status: 429 }) }, 1);
    await call('/ok');
    const limited = await call('/ok');
    expect(await limited.text()).toBe('slow down');
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});

describe('checkRequest', () => {
  it('returns headers for the caller to apply, or a ready response', async () => {
    const limiter = createLimiter({ store: new MemoryStore({ cleanupIntervalMs: 0 }), limit: 1, windowMs: 1000 });
    const req = () => new Request('http://x/', { headers: { 'x-api-key': 'k' } });

    const ok = await checkRequest(limiter, req());
    expect(ok.response).toBeUndefined();
    expect(ok.headers.get('ratelimit-remaining')).toBe('0');

    const limited = await checkRequest(limiter, req());
    expect(limited.response?.status).toBe(429);
  });
});
