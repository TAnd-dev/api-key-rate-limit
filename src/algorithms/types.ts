import type { LimitResult } from '../core/types.js';

export interface AlgorithmParams {
  limit: number;
  windowMs: number;
  cost: number;
}

export interface AlgorithmOutcome<S> {
  state: S;
  result: LimitResult;
  /** Absolute time after which the state carries no information and can be dropped. */
  expiresAt: number;
}
