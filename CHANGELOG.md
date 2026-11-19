# api-key-rate-limit

## 0.1.1

### Patch Changes

- fe52444: `hashKeys: { secret }` with a `Uint8Array` now copies the secret: changing the buffer afterwards no longer changes the hashes. Also compiles with `@types/node` 26.

## 0.1.0

### Minor Changes

- e8ca7e6: First release: per-API-key rate limiting with sliding window and token bucket
  algorithms, in-memory and Redis stores (atomic Lua, server clock), Express,
  Fastify and Fetch adapters, store timeouts with fallback and circuit breaker,
  hashed keys, key validation with per-key plan limits, and per-IP limits for
  anonymous requests and invalid keys.
