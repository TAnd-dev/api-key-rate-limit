/**
 * Key extractors that work with Node (`req.headers` as an object, as in
 * Express and Fastify) and Fetch (`request.headers` as `Headers`) requests.
 */

type NodeHeaders = Record<string, string | string[] | undefined>;
interface FetchHeaders {
  get(name: string): string | null;
}

export interface RequestWithHeaders {
  headers: NodeHeaders | FetchHeaders;
}

export type KeyExtractor<Req = RequestWithHeaders> = (
  req: Req,
) => string | undefined | Promise<string | undefined>;

export function readHeader(req: RequestWithHeaders, name: string): string | undefined {
  const { headers } = req;
  const raw =
    typeof (headers as FetchHeaders).get === 'function'
      ? (headers as FetchHeaders).get(name)
      : (headers as NodeHeaders)[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reads the key from a header, e.g. `fromHeader('x-api-key')`. */
export function fromHeader(name: string): KeyExtractor {
  return (req) => readHeader(req, name);
}

/** Reads the key from `Authorization: Bearer <key>` (scheme is case-insensitive). */
export function fromBearer(): KeyExtractor {
  return (req) => {
    const match = /^bearer\s+(\S+)$/i.exec(readHeader(req, 'authorization') ?? '');
    return match?.[1];
  };
}

/** Tries extractors in order, returns the first key found. */
export function firstOf<Req>(...extractors: KeyExtractor<Req>[]): KeyExtractor<Req> {
  return async (req) => {
    for (const extract of extractors) {
      const key = await extract(req);
      if (key) return key;
    }
    return undefined;
  };
}

/** Default: `X-API-Key` header, then `Authorization: Bearer`. */
export const defaultKeyExtractor: KeyExtractor = firstOf(fromHeader('x-api-key'), fromBearer());
