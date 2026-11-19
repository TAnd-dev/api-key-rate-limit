// Fastify, global hook plus a heavier per-route cost.
import Fastify from 'fastify';
import { createLimiter, MemoryStore } from 'api-key-rate-limit';
import { fastifyLimiter } from 'api-key-rate-limit/fastify';

const limiter = createLimiter({ store: new MemoryStore(), limit: 100, windowMs: 60_000 });

// Behind a reverse proxy on the same host: trust X-Forwarded-For only when
// the connection comes from the proxy's address (or e.g. '10.0.0.0/8').
// Never `trustProxy: true`: then any client picks its own IP by sending the
// header, dodging per-IP limits and getting other addresses blocked.
const app = Fastify({ trustProxy: '127.0.0.1' });
app.addHook('onRequest', fastifyLimiter(limiter));

// Costs 1 (global hook) + 9 (route hook) = 10 units.
app.get('/export', { onRequest: fastifyLimiter(limiter, { cost: 9 }) }, async () => ({ ok: true }));
app.get('/things', async () => []);

await app.listen({ port: 3000 });
