// Hono on Cloudflare Workers (or Bun / Deno): Fetch adapter as middleware.
//
// MemoryStore keeps this example self-contained, but on Workers it only limits
// per isolate, and one client's requests reach many isolates: the real limit
// is several times the configured one. In production use a shared store, as
// in examples/cloudflare-workers (Upstash Redis).
import { Hono } from 'hono';
import { createLimiter, MemoryStore } from 'api-key-rate-limit';
import { createRequestChecker } from 'api-key-rate-limit/fetch';

const limiter = createLimiter({ store: new MemoryStore(), limit: 100, windowMs: 60_000 });
const anonymous = createLimiter({ store: new MemoryStore(), limit: 10, windowMs: 60_000, prefix: 'akl-anon' });

const check = createRequestChecker(limiter, {
  anonymous, // keyless requests: 10/min per IP instead of 401
  // A Fetch Request carries no client address; the platform provides it.
  // CF-Connecting-IP is set by Cloudflare and only trustworthy there: on Bun,
  // Deno or Node any client can send it. Use the server's own API instead
  // (Bun: server.requestIP(req), Deno: info.remoteAddr).
  getIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined,
});

const app = new Hono();

app.use('/api/*', async (c, next) => {
  const result = await check(c.req.raw);
  if (result.response) return result.response; // 401 / 403 / 429
  await next();
  result.headers.forEach((value, name) => c.res.headers.set(name, value));
  result.settle(c.res.status);
});

app.get('/api/things', (c) => c.json([]));

export default app;
