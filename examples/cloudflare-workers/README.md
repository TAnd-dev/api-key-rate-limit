# Cloudflare Workers + Upstash example

A Worker that limits requests per API key, with one limit shared by all isolates and data centres:

- **Counters** live in [Upstash Redis](https://upstash.com), reached over HTTP through `RedisStore({ adapter })`. A `MemoryStore` would count per isolate, and Cloudflare spreads one client's requests over many isolates.
- **Plans** come from Workers KV: each key maps to `{"plan":"free"}` or `{"plan":"pro"}`.
- **Key guessing** is limited per IP (`invalidKeys`), using `CF-Connecting-IP`. Cloudflare sets that header, so clients cannot spoof it here.

## Deploy

```sh
npm install
npx wrangler kv namespace create API_KEYS        # put the id into wrangler.jsonc
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put KEY_HASH_SECRET           # any long random string
npx wrangler kv key put --binding API_KEYS --remote my-key '{"plan":"pro"}'
npx wrangler deploy
```

For `npm run dev`, put the three secrets in `.dev.vars`.

## Test locally

The test runs the Worker in workerd (`wrangler dev`) twice, as two separate instances, with Redis behind an Upstash-compatible REST API ([serverless-redis-http](https://github.com/hiett/serverless-redis-http)):

```sh
# in the package root
npm run build
npm run redis:up
docker run -d --rm --name akl-srh --link akl-redis -p 127.0.0.1:8079:80 \
  -e SRH_MODE=env -e SRH_TOKEN=local-test-token \
  -e SRH_CONNECTION_STRING=redis://akl-redis:6379 hiett/serverless-redis-http

# here
npm install
WRANGLER_SEND_METRICS=false npm test
```

`npm install` here copies the built package from the root (`install-links=true` in `.npmrc`), as if it came from the registry. After changing the package, run `npm run build` in the root and `npm install` here again.

It checks:

- **Shared limit:** the free plan's 10 requests per minute hold across both instances.
- **Plans:** the pro plan's limit comes from KV.
- **Redis is used:** counters are in Redis, not the in-memory fallback, and raw keys never reach Redis.
- **Recovery:** the store works again after `SCRIPT FLUSH`.
- **Rejections:** unknown and missing keys get 401.
- **Key guessing:** guessing from one IP gets 429.
- **CORS:** a preflight is not rejected.
