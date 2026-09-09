/**
 * Warmup bookkeeping every lazily-loaded model reports to the health
 * surfaces (`/ready` detail, the admin components grid). One shape for the
 * embedder and the NLI intent classifier, so "not ready" carries the same
 * attempt count, last error and next retry wherever an operator looks.
 */
export interface WarmupStatus {
  /** The model can serve right now. */
  ready: boolean;
  /** Consecutive failed warmup attempts (0 once ready). */
  failures: number;
  /** A warmup attempt is currently running. */
  inFlight: boolean;
  lastError?: string;
  /** ISO time of the next scheduled attempt, when one is pending. */
  nextRetryAt?: string;
}
