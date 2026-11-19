import { createHash } from 'node:crypto';
import type { Algorithm, ConsumeRequest, LimitResult, Store } from '../core/types.js';
import {
  SLIDING_WINDOW_LUA,
  SLIDING_WINDOW_REFUND_LUA,
  TOKEN_BUCKET_LUA,
  TOKEN_BUCKET_REFUND_LUA,
} from './redis-scripts.js';

/**
 * Minimal surface the store needs. Use it to plug in a client that is neither
 * ioredis nor node-redis.
 */
export interface RedisScriptAdapter {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Structural subset of an ioredis `Redis` / `Cluster` instance. */
export interface IoredisLike {
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/** Structural subset of a node-redis v4/v5 client or cluster. */
export interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  del(key: string): Promise<number>;
}

export type RedisStoreOptions =
  | {
      /** An ioredis or node-redis client; detected automatically. You own its lifecycle. */
      client: IoredisLike | NodeRedisLike;
      clock?: () => number;
    }
  | {
      adapter: RedisScriptAdapter;
      clock?: () => number;
    };

interface Script {
  source: string;
  sha: string;
}

const SCRIPTS: Record<Algorithm, { consume: Script; refund: Script }> = {
  'sliding-window': { consume: script(SLIDING_WINDOW_LUA), refund: script(SLIDING_WINDOW_REFUND_LUA) },
  'token-bucket': { consume: script(TOKEN_BUCKET_LUA), refund: script(TOKEN_BUCKET_REFUND_LUA) },
};

/**
 * Store shared by all app instances. Every consume is a single atomic Lua
 * script on a single key, using the Redis server clock by default.
 */
export class RedisStore implements Store {
  readonly #redis: RedisScriptAdapter;
  readonly #clock: (() => number) | undefined;

  constructor(options: RedisStoreOptions) {
    this.#redis = 'adapter' in options ? options.adapter : adaptClient(options.client);
    // Only for tests: app clocks drift between instances, the server's does not.
    this.#clock = options.clock;
  }

  async consume(request: ConsumeRequest): Promise<LimitResult> {
    const reply = await this.#run(SCRIPTS[request.algorithm].consume, request);
    return parseReply(reply, request.limit);
  }

  async refund(request: ConsumeRequest): Promise<void> {
    await this.#run(SCRIPTS[request.algorithm].refund, request);
  }

  async reset(key: string): Promise<void> {
    await this.#redis.del(key);
  }

  async #run({ sha, source }: Script, { key, limit, windowMs, cost }: ConsumeRequest): Promise<unknown> {
    const keys = [key];
    const args = [String(limit), String(windowMs), String(cost), this.#clock ? String(this.#clock()) : ''];
    try {
      return await this.#redis.evalsha(sha, keys, args);
    } catch (err) {
      // Script cache is empty after a restart, failover or SCRIPT FLUSH.
      // EVAL runs the script and caches it again.
      if (!isNoScript(err)) throw err;
      return this.#redis.eval(source, keys, args);
    }
  }
}

function adaptClient(client: IoredisLike | NodeRedisLike): RedisScriptAdapter {
  // node-redis exposes camelCase `evalSha`; ioredis only lowercase `evalsha`.
  if (typeof (client as NodeRedisLike).evalSha === 'function') {
    const c = client as NodeRedisLike;
    return {
      evalsha: (sha, keys, args) => c.evalSha(sha, { keys, arguments: args }),
      eval: (src, keys, args) => c.eval(src, { keys, arguments: args }),
      del: (key) => c.del(key),
    };
  }
  if (typeof (client as IoredisLike).evalsha === 'function') {
    const c = client as IoredisLike;
    return {
      evalsha: (sha, keys, args) => c.evalsha(sha, keys.length, ...keys, ...args),
      eval: (src, keys, args) => c.eval(src, keys.length, ...keys, ...args),
      del: (key) => c.del(key),
    };
  }
  throw new TypeError('Unsupported Redis client: expected ioredis or node-redis, or pass `adapter`');
}

function script(source: string): Script {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}

function parseReply(reply: unknown, limit: number): LimitResult {
  if (!Array.isArray(reply) || reply.length !== 4) {
    throw new TypeError(`Unexpected reply from rate limit script: ${JSON.stringify(reply)}`);
  }
  const [allowed, remaining, resetMs, retryAfterMs] = reply.map(Number) as [number, number, number, number];
  return { allowed: allowed === 1, limit, remaining, resetMs, retryAfterMs };
}
