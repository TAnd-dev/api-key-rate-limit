# api-key-rate-limit

Rate limiting per API key for Node.js and edge runtimes.

- **Two algorithms:** sliding window (smooth, no burst at window edges) and token bucket (bursts, then a steady rate).
- **Two stores:** in-memory, and Redis for several instances. Each Redis check is one atomic Lua script that uses the Redis server clock.
- **Adapters** for Express, Fastify and anything Fetch-based (Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers). Tested with Express 5 and Fastify 5.
- **Per-key plans:** `validateKey` returns the key's limit; a request that costs more than the plan allows gets 403.
- **Safe with untrusted input:** keys are hashed before storage, unknown keys never reach the store, and keyless requests and key guessing are limited per IP.
- **Store outages:** timeouts, an in-memory fallback store (on by default), a circuit breaker, and a fail-open / fail-closed policy.
- No runtime dependencies.

```sh
npm install api-key-rate-limit
npm install ioredis   # or: npm install redis — only if you use the Redis store
```

Requires Node.js 20+ (or Bun, Deno, Workers). Types need TypeScript 5.4+, or `skipLibCheck`.

## Quick start

```ts
import express from 'express';
import { createLimiter, MemoryStore } from 'api-key-rate-limit';
import { expressLimiter } from 'api-key-rate-limit/express';

const limiter = createLimiter({ store: new MemoryStore(), limit: 100, windowMs: 60_000 });

const app = express();
app.use(
  expressLimiter(limiter, {
    // Required for real protection: without it, a client that sends a new
    // random key with every request gets a fresh limit every time.
    validateKey: async (key) => Boolean(await db.apiKeys.find(key)),
    cacheValidation: { ttlMs: 30_000 },
  }),
); // key from X-API-Key or Authorization: Bearer
```

Each response gets `RateLimit-*` headers. Over the limit, the client gets `429` with `Retry-After`. A request without a key gets `401`, and so does an unknown key.

`MemoryStore` counts per process. With several instances, or on serverless platforms, use a [shared store](#serverless-and-cloudflare-workers).

A complete setup with Redis, a database lookup, per-plan limits and failure handling: [`examples/express.ts`](examples/express.ts). There are also [Fastify](examples/fastify.ts), [Hono](examples/hono.ts) and [Cloudflare Workers with Upstash](examples/cloudflare-workers) examples. The examples are type-checked in CI against the current API.

Before going to production, read the [security checklist](#security-checklist).

## Core API

```ts
const limiter = createLimiter({
  store,                      // MemoryStore | RedisStore | your own Store
  limit: 100,                 // units per window (per key)
  windowMs: 60_000,
  algorithm: 'sliding-window', // or 'token-bucket'
});

const result = await limiter.consume(apiKey, { cost: 1, limit: 500 /* optional per-key override */ });
// { allowed, limit, remaining, resetMs, retryAfterMs, degraded? }

await limiter.refund(apiKey, { cost: 1 }); // give units back, e.g. the request failed
await limiter.reset(apiKey);
```

### Choosing an algorithm

| | `sliding-window` (default) | `token-bucket` |
|---|---|---|
| Guarantees | At most `limit` units in any `windowMs` period | Up to `limit` units at once, refilled at `limit / windowMs` per ms |
| Bursts | Never above `limit` | A full bucket allows `limit` requests at once |
| `resetMs` means | Time until the current fixed window ends | Time until the bucket is full again |
| Good for | Quotas ("1000 per hour") | APIs that tolerate short bursts |

The sliding window is approximated from two counters (current and previous window), so it costs two numbers per key. A plain fixed window lets up to 2× the limit through at the boundary between windows; this one does not.

Both algorithms compute in integers, so `retryAfterMs` is exact: retrying after that wait succeeds, and retrying earlier does not. A randomised test checks this.

### Options

| Option | Default | |
|---|---|---|
| `prefix` | `'akl'` | Namespace for storage keys. See [Several limiters on one store](#several-limiters-on-one-store) |
| `hashKeys` | `true` | `true`: SHA-256. `{ secret }`: HMAC-SHA-256. Or a custom function. `false`: store raw keys |
| `timeoutMs` | `1000` | Max time per store call. `Infinity` disables the timeout |
| `fallback` | in-memory | `{ store, limit? }`, used when the primary store fails. Default: a `MemoryStore` with the same limit (none if the primary is a `MemoryStore`). `false` disables it |
| `onStoreError` | `'fail-open'` | What to do when no store answers: `'fail-open'`, `'fail-closed'` or `'throw'` |
| `circuitBreaker` | `{ failureThreshold: 3, cooldownMs: 5000 }` | `false` disables it |
| `onError` | none | `(error, { operation, store, keyId }) => void` |

### Several limiters on one store

Storage keys are `prefix:algorithm:windowMs:key`. Limiters that differ in window or algorithm can share a store as they are, for example a per-minute and a per-hour limit:

```ts
const perMinute = createLimiter({ store, limit: 100, windowMs: 60_000 });
const perHour = createLimiter({ store, limit: 2_000, windowMs: 3_600_000 });
```

Two limiters with the same window and algorithm, such as a global limit and a stricter one for an expensive route, need distinct prefixes. Otherwise they would count into one counter, and every request would be counted twice. `createLimiter` throws if a second limiter would take the same namespace on the same store object, so create limiters once, at startup, not per request. Across processes it cannot check, so keep prefixes consistent in your configuration.

```ts
const global = createLimiter({ store, limit: 100, windowMs: 60_000 });
const expensive = createLimiter({ store, limit: 5, windowMs: 60_000, prefix: 'akl-export' });
```

## Stores

### Memory

```ts
new MemoryStore({ maxKeys: 100_000, cleanupIntervalMs: 60_000 });
```

Counters are per process. When `maxKeys` is exceeded, the least recently used key is evicted, so a flood of keys cannot exhaust memory.

The cleanup timer starts on first use, so a store can be created at module scope in Cloudflare Workers, which forbid timers during module initialisation. The timer does not keep the process alive.

### Serverless and Cloudflare Workers

A `MemoryStore` only limits within one instance. On serverless platforms there are many instances, and you do not control which one serves a request:

- **Cloudflare Workers** run each isolate with its own memory, in many data centres. One client's requests are spread across isolates, and each isolate counts them separately, so the real limit is several times the configured one. The same goes for AWS Lambda, Vercel functions and similar platforms.
- **Use a shared store there.** The Redis clients that `RedisStore` accepts (ioredis, node-redis) need TCP and do not run on Workers. An HTTP Redis client can be plugged in through `adapter`, for example [Upstash](https://upstash.com):

```ts
import { Redis } from '@upstash/redis/cloudflare';
import { RedisStore } from 'api-key-rate-limit/redis';

const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
const store = new RedisStore({
  adapter: {
    evalsha: (sha, keys, args) => redis.evalsha(sha, keys, args),
    eval: (script, keys, args) => redis.eval(script, keys, args),
    del: (key) => redis.del(key),
  },
});
```

  `RedisStore` imports `node:crypto`, so the Worker needs the `nodejs_compat` compatibility flag. A complete Worker, with plans in Workers KV, is in [`examples/cloudflare-workers`](examples/cloudflare-workers). CI runs it in workerd against an Upstash-compatible API and checks that two separate Worker instances share one limit.
- **Or use the platform's own limiter,** such as Cloudflare's Rate Limiting binding, and this package only for key extraction and plans.

### Redis

```ts
import { RedisStore } from 'api-key-rate-limit/redis';

new RedisStore({ client }); // an ioredis or node-redis client (tested: ioredis 5, node-redis 4); you own its lifecycle
```

- **Atomic.** Read, check and write run in one Lua script, so concurrent requests from many instances never let extra requests through. A test checks that exactly 100 of 1000 parallel requests pass.
- **One clock.** The Redis server clock is used, not each instance's `Date.now()`.
- **Cluster-safe.** Each script touches a single key (a hash), so there are no `CROSSSLOT` errors.
- **Self-healing.** After a Redis restart or failover, the script cache is empty (`NOSCRIPT`). The store detects this and reloads the script.
- **Expiring keys.** Every key has a TTL, so idle keys disappear.

Another client can be plugged in with `new RedisStore({ adapter: { evalsha, eval, del } })`.

Give the limiter its own Redis user with only what it needs, so a compromised app cannot read or wipe other data in the same Redis:

```
ACL SETUSER rate-limiter on >password resetkeys ~akl* resetchannels -@all +evalsha +eval +del +hmget +hset +hget +pexpire +time
```

The key pattern must cover every limiter's `prefix` (`~akl*` covers `akl`, `akl-anon`, `akl-invalid`). Scripts can only run the listed commands on those keys. ioredis also calls `INFO` when connecting; without `+info` it logs a warning and carries on, or pass `enableReadyCheck: false`.

Let the client fail fast while disconnected: `new Redis(url, { enableOfflineQueue: false })` in ioredis, `createClient({ url, disableOfflineQueue: true })` in node-redis. By default both queue commands until Redis is back. Queued commands are then run late: requests already answered from the fallback are counted a second time, so clients may get 429s right after recovery. Failing fast also opens the circuit breaker sooner.

## Adapters

```ts
import { expressLimiter } from 'api-key-rate-limit/express';
import { fastifyLimiter } from 'api-key-rate-limit/fastify';
import { withRateLimit, createRequestChecker } from 'api-key-rate-limit/fetch';

app.use(expressLimiter(limiter, options));                 // Express; result in res.locals.rateLimit
app.addHook('onRequest', fastifyLimiter(limiter, options)); // Fastify; can also be a per-route hook
export default { fetch: withRateLimit(limiter, handler, options) }; // Bun, Deno, Workers
```

`createRequestChecker` is the low-level Fetch API for writing middleware; see the Hono example. Create the checker once, not per request: it holds the IP blocklist used by `invalidKeys`.

**Browsers and CORS.** A CORS preflight (`OPTIONS`) never carries `X-API-Key` or `Authorization`, so the limiter would answer it with 401 and the browser would block the real request. Put your CORS middleware before the limiter (it answers preflights itself), or pass `skip: (req) => req.method === 'OPTIONS'`.

Adapters count API keys and client IPs in separate namespaces (`key:…` and `ip:…`), so a client cannot send the key `ip:1.2.3.4` to use up that address's anonymous quota. To reset a key counted by an adapter, use the same name:

```ts
import { apiKeyBucket } from 'api-key-rate-limit';

await limiter.reset(apiKeyBucket(apiKey));
```

### Adapter options

| Option | Default | |
|---|---|---|
| `getKey` | `X-API-Key`, then `Authorization: Bearer` | Combine `fromHeader(name)`, `fromBearer()`, `firstOf(...)` or write your own |
| `validateKey` | none | `(key, req) => boolean \| { limit? }`, sync or async. See below |
| `cacheValidation` | off | `{ ttlMs, maxEntries? }` |
| `cost` | `1` | A number or `(req) => number` |
| `skip` | none | `(req) => boolean`: bypass the limiter, e.g. for health checks |
| `skipFailedRequests` | `false` | Refund requests whose response failed. Requests aborted by the client are never refunded |
| `isFailure` | `status >= 500` | What counts as failed for `skipFailedRequests`. See the [checklist](#security-checklist) before including 4xx |
| `headers` | `'draft-6'` | `'draft-6'`, `'draft-8'`, `'legacy'` or `false` |
| `missingKey` | `'reject'` | `'reject'` answers 401; `'skip'` lets the request through unlimited |
| `anonymous` | none | A `Limiter` that counts keyless requests per IP instead of rejecting them |
| `invalidKeys` | none | A `Limiter` that counts failed validations per IP |
| `getIp` | `req.ip`, then the socket address | Required by the Fetch adapter when `anonymous` or `invalidKeys` is set |
| `ipv6Subnet` | `56` | IPv6 clients are grouped by this prefix length |
| `maxKeyLength` | `256` | Longer keys are rejected as invalid without a lookup |
| `onLimited` | JSON body | Custom 429 response |
| `onError` | `console.error` | Errors after the response was sent, such as a failed refund |

### Responses

| Status | `error` | When |
|---|---|---|
| 401 | `missing_api_key` | No key; or an anonymous request costs more than the anonymous limit |
| 401 | `invalid_api_key` | `validateKey` rejected the key, or it is longer than `maxKeyLength` |
| 403 | `plan_limit_exceeded` | The request's `cost` is above the key's limit, so it can never pass |
| 429 | `too_many_requests` | Over the limit. Always has `Retry-After`; the body includes `retryAfter` in seconds |

Header styles:

- **`draft-6`:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds from now), `RateLimit-Policy`.
- **`draft-8`:** structured `RateLimit` and `RateLimit-Policy` fields.
- **`legacy`:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds).

## API keys

### Validation and plans

```ts
expressLimiter(limiter, {
  validateKey: async (key) => {
    const row = await db.apiKeys.find(key);
    return row && { limit: PLANS[row.plan].perMinute }; // or `true` for the default limit
  },
  cacheValidation: { ttlMs: 30_000 },
});
```

Without `validateKey`, every distinct string is a new counter. A client sending random keys gets a fresh limit on each request and fills the store. With `validateKey`, unknown keys get 401 and never reach the store.

`cacheValidation` keeps **successful** lookups for `ttlMs` and merges concurrent lookups of the same key into one call:

- A revoked key keeps working until its cache entry expires.
- Invalid keys are not cached, so they cannot push valid ones out.
- With the cache on, `validateKey` must depend only on the key, not on `req`.

A limit returned from `validateKey` applies with the limiter's `windowMs`. For plans with different window lengths, use one limiter per window (see [Several limiters on one store](#several-limiters-on-one-store)).

`validateKey` runs before the limit is checked, because the limit depends on the key's plan. Without `cacheValidation`, a valid key over its limit still costs one lookup per request.

The adapter does not time out `validateKey`: if your database hangs, requests wait with it. Put a timeout on the lookup itself and decide there what a timeout means for you (throwing answers 500).

### Anonymous requests and key guessing

```ts
expressLimiter(limiter, {
  validateKey,
  anonymous: createLimiter({ store, limit: 10, windowMs: 60_000, prefix: 'akl-anon' }),
  invalidKeys: createLimiter({ store, limit: 10, windowMs: 60_000, prefix: 'akl-invalid' }),
});
```

- **`anonymous`** serves keyless requests with a small per-IP quota instead of rejecting them.
- **`invalidKeys`** counts failed lookups per IP. Once an IP exceeds the limit, the adapter answers 429 for that IP *without calling `validateKey`* until the window passes, so guessing cannot load your database.

How client addresses are handled:

- **The default `getIp` is `req.ip`.** It honours Express's `trust proxy` and Fastify's `trustProxy`. Behind a reverse proxy, configure that setting, or every client will share the proxy's address.
- **Trust your proxies' addresses, never `true`.** Use `app.set('trust proxy', 'loopback')` or `Fastify({ trustProxy: '10.0.0.0/8' })` with the addresses your proxies connect from. With `true`, the client's own `X-Forwarded-For` is believed: it can bypass per-IP limits by changing the header on each request, and get another address blocked through `invalidKeys`. A hop count (`'trust proxy', 1` in Express) is safe only if the app cannot be reached except through the proxy; Fastify 5 ignores hop counts.
- **`X-Forwarded-For` is never read directly.** Any client can set it.
- **In the Fetch adapter, `getIp` must use the platform's address.** `CF-Connecting-IP` is trustworthy on Cloudflare only; on Bun, Deno or Node, any client can send it. Use `server.requestIP(req)` in Bun or `info.remoteAddr` in Deno.
- **When `getIp` returns nothing**, all such clients share one `ip:unknown` bucket. That is safer than no limit, but one client can then use it up for everyone, so fix `getIp` if it happens.
- **IPv6 addresses are grouped by /56.** One customer usually controls at least a /64, and /48s are easy to get (tunnel brokers hand them out free, hosting providers assign them). With /64 grouping, one /48 would be 65 536 separate clients; with /56, it is 256. For a stricter limit, add a second limiter with its own `prefix` and `ipv6Subnet: 48`. `::ffff:1.2.3.4` counts as `1.2.3.4`.

### Key storage

By default, keys are hashed with SHA-256 before they reach the store. A Redis dump or `MONITOR` therefore shows no keys. API keys are high-entropy, so SHA-256 alone cannot be reversed. Pass `hashKeys: { secret }` (HMAC) if your keys are short or guessable.

`onError` receives a `keyId` (the hash), never the raw key. Changing `hashKeys` or its secret resets all counters.

## When the store fails

```ts
createLimiter({
  store: new RedisStore({ client }),
  limit: 100,
  windowMs: 60_000,
  timeoutMs: 1000,
  fallback: { store: new MemoryStore(), limit: 25 }, // default: a MemoryStore with the full limit
  onStoreError: 'fail-open',
  onError: (err, info) => logger.warn({ err, ...info }, 'rate limit store failed'),
});
```

On every request, the stores are tried in order: primary store → fallback store → `onStoreError` policy.

- **Timeouts matter.** Redis clients queue commands while disconnected; without a timeout, requests would hang until Redis came back.
- **The circuit breaker** stops calling the primary after `failureThreshold` failures in a row. After `cooldownMs`, one probe request goes through. Without it, every request would wait the full timeout while Redis is down. A probe that has not answered within another `cooldownMs` is given up on, so a hung call cannot keep the breaker from retrying.
- **The fallback store** counts per instance, using the same algorithm. Its limit applies to per-key limits proportionally. By default it is a `MemoryStore` with the same limit, so with N instances a client can get up to N × `limit` while Redis is down. Pass `limit: Math.ceil(limit / N)` to keep the total, or `fallback: false` to go straight to `onStoreError`.
- **Why a fallback by default.** Without one, `fail-open` would mean no limit at all whenever Redis is slow, and a client able to slow Redis down (by flooding it) could switch the limit off exactly when it matters.
- **`onStoreError`** applies when both stores fail:
  - `fail-open` allows the request;
  - `fail-closed` denies it with a 1-second `Retry-After`;
  - `throw` rejects, and adapters pass the error to the framework's error handler.

`result.degraded` (`'fallback'`, `'fail-open'` or `'fail-closed'`) tells you when the primary store did not answer.

## Security checklist

- **Validate keys.** Without `validateKey`, every distinct string is a new counter: a client sending random keys gets a fresh limit on each request, and fills the store. Each new key is one Redis entry until its TTL expires (about two windows), so 10 000 random keys per second with a one-minute window keep up to about 1.2 million entries, on the order of 150 MB. Use `validateKey` with `cacheValidation`, and `invalidKeys` against guessing.
- **Count the credential your app authenticates.** The default `getKey` reads `X-API-Key`, then `Authorization: Bearer`. If your app authenticates a different credential (say, the bearer token) and there is no `validateKey`, a client can add a random `X-API-Key` to each request and get a fresh limit every time. Point `getKey` at the same credential, or use `validateKey`.
- **Use a shared store with several instances.** A `MemoryStore` counts per process; on Cloudflare Workers and other serverless platforms it barely limits at all. See [Serverless and Cloudflare Workers](#serverless-and-cloudflare-workers).
- **Configure the client IP.** Per-IP limits (`anonymous`, `invalidKeys`) are only as good as `getIp`. Trust only your proxies' addresses, never `true`; see [Anonymous requests and key guessing](#anonymous-requests-and-key-guessing).
- **Keep `isFailure` at 5xx.** With `skipFailedRequests`, refunded responses are free. If 4xx count as failures, enumeration (IDs that give 404, bad parameters that give 400) is not limited at all. Never refund for responses that the client can trigger at will.
- **Size the fallback.** The default in-memory fallback multiplies the limit by the number of instances while Redis is down; see [When the store fails](#when-the-store-fails). Watch `onError` and `result.degraded`.
- **Keep a timeout.** `timeoutMs: Infinity` makes every request wait as long as Redis does.
- **Use `hashKeys: { secret }` for short or guessable keys.** With plain SHA-256, someone with a Redis dump can check candidate keys against it.
- **Give each limiter its own namespace.** Limiters with the same window and algorithm on one store need distinct prefixes; see [Several limiters on one store](#several-limiters-on-one-store). `anonymous` and `invalidKeys` should not be the main limiter, so each has its own limit.
- **Give the limiter a restricted Redis user.** See the ACL recipe under [Redis](#redis).
- **Use `cacheValidation`.** Without it, every request, including ones over the limit, calls `validateKey`.

## Known limitations

- **Clock steps.** The memory store uses the app's clock, the Redis store the Redis server's. If that clock steps back by less than a window, counting continues in the stored window. State written more than a window ahead (a clock that was wrong, then corrected) is discarded, so a key gets one fresh limit rather than a lockout until real time catches up.

- **A timeout does not cancel the store call.** If Redis answers after `timeoutMs`, the request is still counted there, after already being counted in the fallback. Disabling the client's offline queue (see [Redis](#redis)) avoids this when Redis is disconnected, but not when it is connected and slow.
- **A refund can land in the wrong window.** In the sliding window, if the window rolls over between the request and its refund, *and* another request with the same key arrives in between, the refund goes to the new window.
- **Refunds after recovery go to Redis.** If Redis recovers between a request answered from the fallback and its refund, the refund goes to Redis. The limit may be slightly looser for a moment.
- **An `invalidKeys` block affects everyone on that IP**, including valid keys, until the window passes. Clients behind the same NAT as an attacker are affected.
- **The `invalidKeys` blocklist is per instance.** Each instance blocks an IP once that IP has exceeded the limit *through it*. The counter itself is shared if the `invalidKeys` limiter uses Redis.

## Development

```sh
npm install
npm run redis:up         # Redis 7 in Docker on port 6390
npm run test:redis       # all tests, including Redis (both clients)
npm test                 # without Redis: the Redis tests are skipped
npm run ci               # typecheck, lint, tests, build, smoke test of dist/, publint + attw
npm run redis:down
```

The Lua scripts mirror the TypeScript algorithms. The Redis tests run both implementations on the same random input and compare every result. Change them together.

Releases use [changesets](https://github.com/changesets/changesets): add a changeset with `npx changeset` in your PR.

## License

MIT
