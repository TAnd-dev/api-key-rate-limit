import { describe, expect, it } from 'vitest';
import { defaultKeyExtractor, firstOf, fromBearer, fromHeader, rateLimitHeaders } from '../src/index.js';

const node = (headers: Record<string, string | string[]>) => ({ headers });
const fetchReq = (headers: Record<string, string>) => new Request('http://x/', { headers });

describe('key extractors', () => {
  it('fromHeader reads Node and Fetch headers case-insensitively', async () => {
    const get = fromHeader('X-API-Key');
    expect(await get(node({ 'x-api-key': ' abc ' }))).toBe('abc');
    expect(await get(node({ 'x-api-key': ['first', 'second'] }))).toBe('first');
    expect(await get(fetchReq({ 'X-Api-Key': 'abc' }))).toBe('abc');
    expect(await get(node({ 'x-api-key': '   ' }))).toBeUndefined();
    expect(await get(node({}))).toBeUndefined();
  });

  it('fromBearer parses the Authorization header', async () => {
    const get = fromBearer();
    expect(await get(node({ authorization: 'Bearer tok' }))).toBe('tok');
    expect(await get(node({ authorization: 'bearer   tok' }))).toBe('tok');
    expect(await get(node({ authorization: 'Basic dXNlcg==' }))).toBeUndefined();
    expect(await get(node({ authorization: 'Bearer a b' }))).toBeUndefined();
  });

  it('firstOf and the default extractor try sources in order', async () => {
    expect(await defaultKeyExtractor(node({ 'x-api-key': 'h', authorization: 'Bearer b' }))).toBe('h');
    expect(await defaultKeyExtractor(node({ authorization: 'Bearer b' }))).toBe('b');
    const custom = firstOf<{ headers: Record<string, string>; q?: string }>(() => undefined, (r) => r.q);
    expect(await custom({ headers: {}, q: 'from-query' })).toBe('from-query');
  });
});

describe('rateLimitHeaders', () => {
  const allowed = { allowed: true, limit: 100, remaining: 42, resetMs: 29_001, retryAfterMs: 0 };
  const denied = { ...allowed, allowed: false, remaining: 0, retryAfterMs: 1_500 };

  it('draft-6', () => {
    expect(rateLimitHeaders(allowed, 60_000, 'draft-6')).toEqual({
      'RateLimit-Policy': '100;w=60',
      'RateLimit-Limit': '100',
      'RateLimit-Remaining': '42',
      'RateLimit-Reset': '30',
    });
  });

  it('draft-8', () => {
    expect(rateLimitHeaders(allowed, 60_000, 'draft-8')).toEqual({
      'RateLimit-Policy': '"default";q=100;w=60',
      RateLimit: '"default";r=42;t=30',
    });
  });

  it('legacy uses Unix seconds for reset', () => {
    expect(rateLimitHeaders(allowed, 60_000, 'legacy', 1_000_000)['X-RateLimit-Reset']).toBe('1030');
  });

  it('always adds Retry-After when denied, rounded up', () => {
    expect(rateLimitHeaders(denied, 60_000, false)).toEqual({ 'Retry-After': '2' });
    expect(rateLimitHeaders({ ...denied, retryAfterMs: 1 }, 60_000, false)['Retry-After']).toBe('1');
  });
});
