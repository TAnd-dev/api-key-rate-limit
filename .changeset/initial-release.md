---
"api-key-rate-limit": minor
---

First release: per-API-key rate limiting with sliding window and token bucket
algorithms, in-memory and Redis stores (atomic Lua, server clock), Express,
Fastify and Fetch adapters, store timeouts with fallback and circuit breaker,
hashed keys, key validation with per-key plan limits, and per-IP limits for
anonymous requests and invalid keys.
