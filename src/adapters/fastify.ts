import type { Limiter } from '../core/limiter.js';
import type { LimitResult } from '../core/types.js';
import { createDecider, type AdapterOptions } from './core.js';

/** Structural subset of Fastify request/reply (tested with Fastify 5), so `fastify` is not required at build time. */
export interface FastifyRequestLike {
  headers: Record<string, string | string[] | undefined>;
  /** Client address honouring Fastify's `trustProxy` setting. */
  ip?: string;
}

export interface FastifyReplyLike {
  statusCode: number;
  sent: boolean;
  raw: {
    headersSent: boolean;
    once(event: 'finish' | 'close', listener: () => void): unknown;
  };
  header(name: string, value: string): unknown;
  code(status: number): FastifyReplyLike;
  send(body?: unknown): unknown;
}

export interface FastifyLimiterOptions<Req extends FastifyRequestLike, Reply extends FastifyReplyLike>
  extends AdapterOptions<Req> {
  /** Custom 429 response; must send the reply. Default: JSON `{ error, message, retryAfter }`. */
  onLimited?: (request: Req, reply: Reply, result: LimitResult) => unknown;
}

/**
 * Fastify `onRequest` hook. Register it globally or per route:
 *
 * ```ts
 * app.addHook('onRequest', fastifyLimiter(limiter));
 * app.get('/expensive', { onRequest: fastifyLimiter(limiter, { cost: 10 }) }, handler);
 * ```
 */
export function fastifyLimiter<
  Req extends FastifyRequestLike = FastifyRequestLike,
  Reply extends FastifyReplyLike = FastifyReplyLike,
>(limiter: Limiter, options: FastifyLimiterOptions<Req, Reply> = {}) {
  const decide = createDecider(limiter, options);
  // Errors thrown here propagate to Fastify's error handler. NoInfer: without it
  // TS infers Req/Reply from the route's hook type and ends up with `never`.
  return async function apiKeyLimiter(request: NoInfer<Req>, reply: NoInfer<Reply>): Promise<void> {
    const decision = await decide(request);

    switch (decision.kind) {
      case 'skip':
        return;

      case 'reject':
        await reply.code(decision.status).send(decision.body);
        return;

      case 'limited':
        for (const [name, value] of Object.entries(decision.headers)) reply.header(name, value);
        if (options.onLimited) await options.onLimited(request, reply, decision.result);
        else await reply.code(decision.status).send(decision.body);
        return;

      case 'allowed': {
        for (const [name, value] of Object.entries(decision.headers)) reply.header(name, value);
        const { settle } = decision;
        reply.raw.once('finish', () => settle(reply.statusCode));
        reply.raw.once('close', () => settle(reply.raw.headersSent ? reply.statusCode : undefined));
        return;
      }
    }
  };
}
