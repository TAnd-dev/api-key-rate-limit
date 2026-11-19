---
"api-key-rate-limit": patch
---

`hashKeys: { secret }` with a `Uint8Array` now copies the secret: changing the buffer afterwards no longer changes the hashes. Also compiles with `@types/node` 26.
