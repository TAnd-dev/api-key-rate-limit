/** A store call took longer than `timeoutMs`. The call itself may still complete later. */
export class StoreTimeoutError extends Error {
  override readonly name = 'StoreTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`Rate limit store did not respond within ${timeoutMs} ms`);
  }
}

/** The primary store was skipped because its circuit is open, and nothing else could answer. */
export class StoreUnavailableError extends Error {
  override readonly name = 'StoreUnavailableError';
  constructor() {
    super('Rate limit store unavailable (circuit open)');
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default: 3. */
  failureThreshold?: number;
  /** How long to skip the store once open, before letting one probe through. Default: 5 000 ms. */
  cooldownMs?: number;
}

/**
 * Stops calling a store that keeps failing, so every request does not pay the
 * full timeout while Redis is down. After `cooldownMs` a single probe request
 * is let through; its success closes the circuit, its failure re-opens it.
 * A probe that has not answered within another `cooldownMs` is given up on,
 * so a hung call cannot keep the circuit half-open forever.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  #failures = 0;
  #openUntil = 0;
  /** While a probe is in flight: until when it holds the slot. */
  #probeUntil = 0;

  constructor({ failureThreshold = 3, cooldownMs = 5_000 }: CircuitBreakerOptions = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!(cooldownMs >= 0)) throw new RangeError('cooldownMs must be >= 0');
    this.#threshold = failureThreshold;
    this.#cooldownMs = cooldownMs;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#failures < this.#threshold) return 'closed';
    return Date.now() < this.#openUntil ? 'open' : 'half-open';
  }

  /** Whether a call may go to the store now. Reserves the probe slot when half-open. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    const now = Date.now();
    if (state === 'open' || now < this.#probeUntil) return false;
    // Expired probes free the slot too; at least 1 ms so cooldownMs: 0 still serialises.
    this.#probeUntil = now + Math.max(this.#cooldownMs, 1);
    return true;
  }

  success(): void {
    this.#failures = 0;
    this.#probeUntil = 0;
  }

  failure(): void {
    this.#failures++;
    this.#probeUntil = 0;
    if (this.#failures >= this.#threshold) this.#openUntil = Date.now() + this.#cooldownMs;
  }
}
