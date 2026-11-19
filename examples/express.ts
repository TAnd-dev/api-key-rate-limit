// Express + Redis, keys validated against a database, per-plan limits.
import express from 'express';
import { Redis } from 'ioredis';
import { createLimiter, MemoryStore } from 'api-key-rate-limit';
import { expressLimiter } from 'api-key-rate-limit/express';
import { RedisStore } from 'api-key-rate-limit/redis';

declare const db: { apiKeys: { find(key: string): Promise<{ plan: 'free' | 'pro' } | null> } };
const PLANS = { free: 60, pro: 600 } as const; // requests per minute

// Fail fast while disconnected instead of queueing commands: the limiter
// falls back to memory right away, and nothing is counted twice later.
const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false });

const limiter = createLimiter({
  store: new RedisStore({ client: redis }),
  limit: PLANS.free,
  windowMs: 60_000,
  hashKeys: { secret: process.env.KEY_HASH_SECRET! },
  // If Redis is down: count per instance in memory instead of not at all.
  fallback: { store: new MemoryStore(), limit: Math.ceil(PLANS.free / 4) },
  onError: (err, { operation, keyId }) => console.warn('rate limit store error', operation, keyId, err),
});

// Failed key lookups per IP: stops key guessing from hammering the database.
const invalidKeys = createLimiter({
  store: new RedisStore({ client: redis }),
  limit: 10,
  windowMs: 60_000,
  prefix: 'akl-invalid',
});

const app = express();
// Trust X-Forwarded-For only from the reverse proxy's address, so req.ip is
// the client. Never `true`: any client could then choose its own IP.
app.set('trust proxy', 'loopback');

app.use(
  '/api',
  expressLimiter<express.Request, express.Response>(limiter, {
    validateKey: async (key) => {
      const row = await db.apiKeys.find(key);
      return row && { limit: PLANS[row.plan] };
    },
    cacheValidation: { ttlMs: 30_000 },
    invalidKeys,
    cost: (req) => (req.path.startsWith('/reports') ? 10 : 1),
    skipFailedRequests: true,
  }),
);

app.get('/api/things', (_req, res) => {
  res.json({ rateLimit: res.locals.rateLimit });
});

app.listen(3000);
