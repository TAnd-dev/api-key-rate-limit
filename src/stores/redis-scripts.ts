/**
 * Lua ports of src/algorithms/*.ts. They must stay in sync: test/redis.test.ts
 * runs both implementations on the same random input and compares results.
 *
 * Each script touches exactly one key (a hash), so it is Redis Cluster safe
 * without hash tags and atomic by construction.
 *
 * KEYS[1] = storage key
 * ARGV    = limit, windowMs, cost, now ('' = use Redis server time)
 * Returns   { allowed (0|1), remaining, resetMs, retryAfterMs }
 *
 * Numbers are written with '%.0f' because Lua's default number-to-string
 * conversion keeps only 14 significant digits.
 */

const PRELUDE = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
if not now then
  -- Redis < 5 needs effect replication before a write that follows TIME.
  if redis.replicate_commands then redis.replicate_commands() end
  -- Server time: every app instance sees the same clock.
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function int(x) return string.format('%.0f', x) end
`;

export const SLIDING_WINDOW_LUA = `${PRELUDE}
local s = redis.call('HMGET', key, 'w', 'c', 'p')
local storedWindow = tonumber(s[1])
local window = math.floor(now / windowMs)
-- Clock stepped back: by up to a window, keep counting in the stored window
-- from its start; further, the state came from a wrong clock, start over.
if storedWindow and storedWindow == window + 1 then
  now = storedWindow * windowMs
  window = storedWindow
elseif storedWindow and storedWindow > window then
  storedWindow = nil
end
local current, previous = 0, 0
if storedWindow == window then
  current = tonumber(s[2]) or 0
  previous = tonumber(s[3]) or 0
elseif storedWindow == window - 1 then
  previous = tonumber(s[2]) or 0
end

local elapsed = now - window * windowMs
local resetMs = windowMs - elapsed
local capacity = limit * windowMs
local estimated = previous * (windowMs - elapsed) + current * windowMs
local allowed = estimated + cost * windowMs <= capacity

if allowed then
  current = current + cost
  estimated = estimated + cost * windowMs
  redis.call('HSET', key, 'w', int(window), 'c', int(current), 'p', int(previous))
  redis.call('PEXPIRE', key, int((window + 2) * windowMs - now))
  return { 1, math.max(0, math.floor((capacity - estimated) / windowMs)), resetMs, 0 }
end

-- Denied: nothing to write, the stored state already implies this one.
local remaining = math.max(0, math.floor((capacity - estimated) / windowMs))
local retry
local budgetNow = limit - current - cost
if budgetNow >= 0 and previous > 0 then
  retry = windowMs - math.floor(budgetNow * windowMs / previous) - elapsed
else
  local untilNext = windowMs - elapsed
  local budgetNext = limit - cost
  if current <= budgetNext then
    retry = untilNext
  else
    retry = untilNext + windowMs - math.floor(budgetNext * windowMs / current)
  end
end
return { 0, remaining, resetMs, math.max(1, retry) }
`;

export const TOKEN_BUCKET_LUA = `${PRELUDE}
local capacity = limit * windowMs
local tokens = capacity
local s = redis.call('HMGET', key, 't', 'u')
local stored = tonumber(s[1])
local updatedAt = tonumber(s[2])
-- Written by a clock more than a window ahead: start over (see token-bucket.ts).
if updatedAt and updatedAt - now > windowMs then stored = nil end
if stored and updatedAt then
  local elapsed = math.min(math.max(0, now - updatedAt), windowMs)
  tokens = math.min(capacity, stored + elapsed * limit)
end

local need = cost * windowMs
local allowed = tokens >= need
if allowed then tokens = tokens - need end
local resetMs = math.ceil((capacity - tokens) / limit)
local remaining = math.floor(tokens / windowMs)

if not allowed then
  return { 0, remaining, resetMs, math.ceil((need - tokens) / limit) }
end

-- cost >= 1, so the bucket is not full and resetMs > 0; once full, the
-- state equals "no state" and the key may expire.
redis.call('HSET', key, 't', int(tokens), 'u', int(now))
redis.call('PEXPIRE', key, int(resetMs))
return { 1, remaining, resetMs, 0 }
`;

/**
 * Refund scripts: same KEYS/ARGV as above (ARGV[4] unused). They only adjust
 * an existing hash, keeping its TTL; a missing key means nothing to give back.
 */
export const SLIDING_WINDOW_REFUND_LUA = `
local current = tonumber(redis.call('HGET', KEYS[1], 'c'))
if current then
  local cost = tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], 'c', string.format('%.0f', math.max(0, current - cost)))
end
return 1
`;

export const TOKEN_BUCKET_REFUND_LUA = `
local tokens = tonumber(redis.call('HGET', KEYS[1], 't'))
if tokens then
  local limit, windowMs, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
  local refilled = math.min(limit * windowMs, tokens + cost * windowMs)
  redis.call('HSET', KEYS[1], 't', string.format('%.0f', refilled))
end
return 1
`;
