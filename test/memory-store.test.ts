import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/stores/memory.js';
import type { ConsumeRequest } from '../src/core/types.js';

const req = (key: string, over: Partial<ConsumeRequest> = {}): ConsumeRequest => ({
  key,
  algorithm: 'sliding-window',
  limit: 3,
  windowMs: 1000,
  cost: 1,
  ...over,
});

describe('MemoryStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks keys independently', async () => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    for (let i = 0; i < 3; i++) await store.consume(req('a'));
    expect((await store.consume(req('a'))).allowed).toBe(false);
    expect((await store.consume(req('b'))).allowed).toBe(true);
  });

  it('reset clears a key', async () => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    for (let i = 0; i < 3; i++) await store.consume(req('a'));
    await store.reset('a');
    expect((await store.consume(req('a'))).allowed).toBe(true);
  });

  it('evicts the least recently used key beyond maxKeys', async () => {
    const store = new MemoryStore({ maxKeys: 2, clock: () => 0, cleanupIntervalMs: 0 });
    for (let i = 0; i < 3; i++) await store.consume(req('a'));
    await store.consume(req('b'));
    await store.consume(req('a')); // touch "a" so "b" becomes the LRU entry
    await store.consume(req('c'));

    expect(store.size).toBe(2);
    // "a" survived with its counter intact.
    expect((await store.consume(req('a'))).allowed).toBe(false);
  });

  it('sweeps expired entries on a timer', async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore({ cleanupIntervalMs: 500 });
    await store.consume(req('a'));
    expect(store.size).toBe(1);

    vi.advanceTimersByTime(2500); // entry expires at (0 + 2) * 1000
    expect(store.size).toBe(0);
    await store.close();
  });

  it('starts the cleanup timer lazily (Workers forbid timers at module init)', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const store = new MemoryStore();
    expect(spy).not.toHaveBeenCalled();
    await store.consume(req('a'));
    await store.consume(req('b'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await store.close();
  });

  it('cleanup timer does not keep the process alive', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const store = new MemoryStore();
    await store.consume(req('a'));
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
    void store.close();
  });

  it('rejects invalid maxKeys', () => {
    expect(() => new MemoryStore({ maxKeys: 0 })).toThrow(RangeError);
  });
});

describe('MemoryStore algorithm switching', () => {
  it('ignores state written by a different algorithm under the same key', async () => {
    const store = new MemoryStore({ clock: () => 0, cleanupIntervalMs: 0 });
    for (let i = 0; i < 3; i++) await store.consume(req('a'));
    const tb = await store.consume(req('a', { algorithm: 'token-bucket' }));
    expect(tb).toMatchObject({ allowed: true, remaining: 2 });
  });
});
