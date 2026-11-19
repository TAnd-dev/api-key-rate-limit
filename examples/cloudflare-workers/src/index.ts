// Cloudflare Worker: per-API-key rate limiting shared across all isolates and
// data centres through Upstash Redis (HTTP), plans from Workers KV.
import { Redis } from '@upstash/redis/cloudflare';
import { createLimiter } from 'api-key-rate-limit';
import { createRequestChecker, type RateLimitCheck } from 'api-key-rate-limit/fetch';
import { RedisStore } from 'api-key-rate-limit/redis';

interface Env {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  /** Any long random string; HMAC for keys in Redis. */
  KEY_HASH_SECRET: string;
  API_KEYS: KVNamespace;
}

const PLANS = { free: 10, pro: 100 } as const; // requests per minute
type Plan = keyof typeof PLANS;

type Checker = (request: Request) => Promise<RateLimitCheck>;
let checker: Checker | undefined;

/**
 * Built on the first request: bindings and secrets only exist in `env`.
 * Kept for the isolate's lifetime; never create limiters per request.
 */
function getChecker(env: Env): Checker {
  if (checker) return checker;

  const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  const store = new RedisStore({
    adapter: {
      evalsha: (sha, keys, args) => redis.evalsha(sha, keys, args),
      eval: (script, keys, args) => redis.eval(script, keys, args),
      del: (key) => redis.del(key),
    },
  });

  const limiter = createLimiter({
    store,
    limit: PLANS.free,
    windowMs: 60_000,
    hashKeys: { secret: env.KEY_HASH_SECRET },
    timeoutMs: 2_000, // an HTTP round trip, possibly to another region
  });
  const invalidKeys = createLimiter({ store, limit: 10, windowMs: 60_000, prefix: 'akl-invalid' });

  checker = createRequestChecker(limiter, {
    validateKey: async (key) => {
      const row = await env.API_KEYS.get<{ plan: Plan }>(key, 'json');
      return row && { limit: PLANS[row.plan] };
    },
    cacheValidation: { ttlMs: 30_000 },
    invalidKeys,
    // Set by Cloudflare's edge on every request, so it cannot be spoofed here.
    getIp: (request) => request.headers.get('cf-connecting-ip') ?? undefined,
    skip: (request) => request.method === 'OPTIONS', // CORS preflights carry no key
  });
  return checker;
}

export default {
  async fetch(request, env): Promise<Response> {
    const check = await getChecker(env)(request);
    if (check.response) return check.response; // 401 / 403 / 429

    const response = Response.json({ ok: true, rateLimit: check.result });
    check.headers.forEach((value, name) => response.headers.set(name, value));
    check.settle(response.status);
    return response;
  },
} satisfies ExportedHandler<Env>;
