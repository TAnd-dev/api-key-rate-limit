// End-to-end check of the Worker in workerd (via `wrangler dev`), with Redis
// behind an Upstash-compatible REST API.
//
// Needs, besides `npm install` here and `npm run build` in the package root:
//   - Redis:        npm run redis:up            (in the package root)
//   - Upstash API:  docker run -d --rm --name akl-srh --link akl-redis -p 127.0.0.1:8079:80 \
//                     -e SRH_MODE=env -e SRH_TOKEN=local-test-token \
//                     -e SRH_CONNECTION_STRING=redis://akl-redis:6379 hiett/serverless-redis-http
// Override with UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? 'http://127.0.0.1:8079';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? 'local-test-token';
const PORTS = [8788, 8789];
const run = randomUUID().slice(0, 8);
const KEYS = { free: `free-${run}`, pro: `pro-${run}` };

async function redis(...command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

// No usage metrics to Cloudflare from test runs.
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
// Each instance gets its own local state (KV): two workerd processes cannot share one.
const stateDir = (port) => `.wrangler/test-state-${port}`;
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { stdio: 'pipe', env }).toString();

function startWorker(port) {
  const child = spawn(
    'npx',
    [
      'wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1000),
      '--var', `UPSTASH_REDIS_REST_URL:${UPSTASH_URL}`,
      '--var', `UPSTASH_REDIS_REST_TOKEN:${UPSTASH_TOKEN}`,
      '--var', `KEY_HASH_SECRET:test-secret-${run}`,
      '--persist-to', stateDir(port),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, port, log: () => log };
}

async function waitReady(worker) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`http://127.0.0.1:${worker.port}/`, { method: 'OPTIONS' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`wrangler dev on ${worker.port} did not start:\n${worker.log()}`);
}

const call = (port, key, init = {}) =>
  fetch(`http://127.0.0.1:${port}/`, { ...init, headers: { ...(key ? { 'x-api-key': key } : {}), ...init.headers } });

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

// The API may still be starting (CI service containers start in parallel).
for (let i = 0; ; i++) {
  try {
    assert.equal(await redis('PING'), 'PONG');
    break;
  } catch (err) {
    if (i === 30) throw new Error(`Upstash-compatible API not reachable at ${UPSTASH_URL}`, { cause: err });
    await new Promise((r) => setTimeout(r, 1000));
  }
}
for (const port of PORTS) {
  for (const [plan, key] of Object.entries(KEYS)) {
    wrangler('kv', 'key', 'put', '--binding', 'API_KEYS', '--local', '--persist-to', stateDir(port), key, JSON.stringify({ plan }));
  }
}

const workers = PORTS.map(startWorker);
try {
  await Promise.all(workers.map(waitReady));
  const [a, b] = PORTS;

  await check('free plan: 10 per minute across two separate Worker instances, then 429', async () => {
    const statuses = [];
    // Alternate between the instances, as requests spread across isolates.
    for (let i = 0; i < 12; i++) statuses.push((await call(i % 2 ? b : a, KEYS.free)).status);
    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
    const limited = await call(a, KEYS.free);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await limited.json()).error, 'too_many_requests');
  });

  await check('pro plan: limit 100 from KV, counted in Redis (not the fallback)', async () => {
    const res = await call(b, KEYS.pro);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ratelimit-limit'), '100');
    const body = await res.json();
    assert.equal(body.rateLimit.remaining, 99);
    assert.equal(body.rateLimit.degraded, undefined);
    const stored = await redis('KEYS', 'akl:sliding-window:60000:*');
    assert.ok(stored.length >= 2, 'counters are in Redis');
    assert.ok(!stored.some((k) => k.includes(run)), 'raw keys never reach Redis');
  });

  await check('recovers after the script cache is flushed (NOSCRIPT)', async () => {
    await redis('SCRIPT', 'FLUSH');
    const res = await call(a, KEYS.pro);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rateLimit.remaining, 98);
    assert.equal(body.rateLimit.degraded, undefined);
  });

  await check('401 for unknown and missing keys', async () => {
    const unknown = await call(a, `nope-${run}`);
    assert.equal(unknown.status, 401);
    assert.equal((await unknown.json()).error, 'invalid_api_key');
    assert.equal((await call(a, undefined)).status, 401);
  });

  await check('invalidKeys: key guessing from one IP is cut off with 429', async () => {
    const ip = { 'cf-connecting-ip': `198.51.100.${Math.floor(Math.random() * 250)}` };
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(i % 2 ? b : a, `guess-${run}-${i}`, { headers: ip })).status);
    assert.ok(statuses.slice(0, 9).every((s) => s === 401), statuses.join());
    assert.equal(statuses.at(-1), 429, statuses.join());
  });

  await check('CORS preflight is not rejected', async () => {
    assert.notEqual((await call(a, undefined, { method: 'OPTIONS' })).status, 401);
  });
} finally {
  for (const w of workers) {
    try {
      process.kill(-w.child.pid);
    } catch {}
  }
}
console.log(`\n${results.length} checks passed`);
