import type { Algorithm } from '../core/types.js';
import { refundSlidingWindow, slidingWindow, type SlidingWindowState } from './sliding-window.js';
import { refundTokenBucket, tokenBucket, type TokenBucketState } from './token-bucket.js';
import type { AlgorithmOutcome, AlgorithmParams } from './types.js';

export const ALGORITHMS: readonly Algorithm[] = ['sliding-window', 'token-bucket'];

/** State of any algorithm, tagged so a store never feeds one algorithm's state to another. */
export type AlgorithmState =
  | { algorithm: 'sliding-window'; state: SlidingWindowState }
  | { algorithm: 'token-bucket'; state: TokenBucketState };

/** Runs `algorithm`, ignoring `prev` if it belongs to a different algorithm. */
export function runAlgorithm(
  algorithm: Algorithm,
  prev: AlgorithmState | undefined,
  now: number,
  params: AlgorithmParams,
): AlgorithmOutcome<AlgorithmState> {
  switch (algorithm) {
    case 'sliding-window': {
      const out = slidingWindow(prev?.algorithm === algorithm ? prev.state : undefined, now, params);
      return { ...out, state: { algorithm, state: out.state } };
    }
    case 'token-bucket': {
      const out = tokenBucket(prev?.algorithm === algorithm ? prev.state : undefined, now, params);
      return { ...out, state: { algorithm, state: out.state } };
    }
    default: {
      const unknown: never = algorithm;
      throw new TypeError(`Unknown algorithm: ${String(unknown)}`);
    }
  }
}

/** Refunds `params.cost` units into `state`. */
export function refundAlgorithm(state: AlgorithmState, params: AlgorithmParams): AlgorithmState {
  switch (state.algorithm) {
    case 'sliding-window':
      return { algorithm: state.algorithm, state: refundSlidingWindow(state.state, params.cost) };
    case 'token-bucket':
      return { algorithm: state.algorithm, state: refundTokenBucket(state.state, params) };
  }
}
