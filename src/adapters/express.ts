import type { Limiter } from '../core/limiter.js';
import type { LimitResult } from '../core/types.js';
import { createDecider, type AdapterOptions } from './core.js';

/** Structural subset of Express req/res (tested with Express 5), so `@types/express` is not required. */
export interface ExpressRequestLike {
  headers: Record<string, string | string[] | undefined>;
  /** Client address honouring Express's `trust proxy` setting. */
  ip?: string | undefined;
}

export interface ExpressResponseLike {
  statusCode: number;
  headersSent: boolean;
  locals: Record<string, unknown>;
  setHeader(name: string, value: string): unknown;
  status(code: number): ExpressResponseLike;
  json(body: unknown): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

export type ExpressNext = (err?: unknown) => void;

export interface ExpressLimiterOptions<Req extends ExpressRequestLike, Res extends ExpressResponseLike>
  extends AdapterOptions<Req> {
  /** Custom 429 response. Default: JSON `{ error, message, retryAfter }`. */
  onLimited?: (req: Req, res: Res, result: LimitResult) => void;
}

/**
 * Express middleware. The result is available to later handlers as
 * `res.locals.rateLimit`.
 *
 * ```ts
 * app.use(expressLimiter(limiter, { getKey: fromHeader('x-api-key') }));
 * ```
 */
export function expressLimiter<
  Req extends ExpressRequestLike = ExpressRequestLike,
  Res extends ExpressResponseLike = ExpressResponseLike,
>(limiter: Limiter, options: ExpressLimiterOptions<Req, Res> = {}) {
  const decide = createDecider(limiter, options);
  return async function apiKeyLimiter(req: Req, res: Res, next: ExpressNext): Promise<void> {
    let decision;
    try {
      decision = await decide(req);
    } catch (err) {
      next(err);
      return;
    }

    switch (decision.kind) {
      case 'skip':
        next();
        return;

      case 'reject':
        res.status(decision.status).json(decision.body);
        return;

      case 'limited':
        setHeaders(res, decision.headers);
        if (options.onLimited) options.onLimited(req, res, decision.result);
        else res.status(decision.status).json(decision.body);
        return;

      case 'allowed': {
        setHeaders(res, decision.headers);
        res.locals.rateLimit = decision.result;
        const { settle } = decision;
        res.once('finish', () => settle(res.statusCode));
        // 'close' without 'finish': the client went away before the response was sent.
        res.once('close', () => settle(res.headersSent ? res.statusCode : undefined));
        next();
        return;
      }
    }
  };
}

function setHeaders(res: ExpressResponseLike, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}
