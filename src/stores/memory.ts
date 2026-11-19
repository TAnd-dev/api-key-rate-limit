import { refundAlgorithm, runAlgorithm, type AlgorithmState } from '../algorithms/index.js';
import type { ConsumeRequest, LimitResult, Store } from '../core/types.js';

export interface MemoryStoreOptions {
  /**
   * Upper bound on tracked keys. When exceeded, the least recently used key is
   * evicted, so a flood of random keys cannot exhaust memory. Default: 100 000.
   */
  maxKeys?: number;
  /** How often expired entries are swept, in ms. 0 disables the sweep. Default: 60 000. */
  cleanupIntervalMs?: number;
  /** Time source, injectable for tests. Default: `Date.now`. */
  clock?: () => number;
}

interface Entry {
  state: AlgorithmState;
  expiresAt: number;
}

/**
 * Single-process store. Limits are not shared between processes or instances;
 * use the Redis store for that.
 */
export class MemoryStore implements Store {
  readonly #entries = new Map<string, Entry>();
  readonly #maxKeys: number;
  readonly #clock: () => number;
  readonly #cleanupIntervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: MemoryStoreOptions = {}) {
    const { maxKeys = 100_000, cleanupIntervalMs = 60_000, clock = Date.now } = options;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError('maxKeys must be a positive integer');
    }
    this.#maxKeys = maxKeys;
    this.#clock = clock;
    this.#cleanupIntervalMs = cleanupIntervalMs;
  }

  /**
   * Starts the sweep on first use, not in the constructor: Cloudflare Workers
   * forbid timers during module initialisation, where stores are usually created.
   */
  #startCleanup(): void {
    if (this.#timer || this.#closed || this.#cleanupIntervalMs <= 0) return;
    this.#timer = setInterval(() => this.#sweep(), this.#cleanupIntervalMs);
    // Do not keep the process alive just for cleanup.
    this.#timer.unref?.();
  }

  /** Number of tracked keys (expired entries not yet swept included). */
  get size(): number {
    return this.#entries.size;
  }

  async consume(request: ConsumeRequest): Promise<LimitResult> {
    return this.consumeSync(request);
  }

  /** Synchronous variant; the store never awaits anything internally. */
  consumeSync({ key, algorithm, limit, windowMs, cost }: ConsumeRequest): LimitResult {
    this.#startCleanup();
    const now = this.#clock();
    const existing = this.#entries.get(key);
    const prev = existing && existing.expiresAt > now ? existing.state : undefined;

    const outcome = runAlgorithm(algorithm, prev, now, { limit, windowMs, cost });

    // Re-insert to move the key to the most-recently-used end of the Map.
    this.#entries.delete(key);
    this.#entries.set(key, { state: outcome.state, expiresAt: outcome.expiresAt });
    this.#evictOverflow();

    return outcome.result;
  }

  async refund({ key, algorithm, limit, windowMs, cost }: ConsumeRequest): Promise<void> {
    const entry = this.#entries.get(key);
    // Expired or written by another algorithm: nothing left to give back.
    if (!entry || entry.expiresAt <= this.#clock() || entry.state.algorithm !== algorithm) return;
    entry.state = refundAlgorithm(entry.state, { limit, windowMs, cost });
  }

  async reset(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#closed = true;
    this.#entries.clear();
  }

  #evictOverflow(): void {
    // Map iterates in insertion order, so the first key is the least recently used.
    while (this.#entries.size > this.#maxKeys) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  #sweep(): void {
    const now = this.#clock();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
