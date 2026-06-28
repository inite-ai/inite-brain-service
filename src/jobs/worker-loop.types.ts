import type { JobType } from './job-run.service';

/** Execution context handed to a registered job handler. */
export interface JobContext {
  runId: string;
  jobType: JobType;
  companyId: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  /**
   * Aborts on: (a) handler exceeded leaseUntil and lost the claim;
   * (b) operator flipped cancelRequested via /admin/jobs/:id/cancel;
   * (c) pod shutdown. Handlers MUST pass this into long-running
   * primitives (fetch / OpenAI client / Surreal queries) so cancel
   * actually terminates the work instead of just flagging the row.
   */
  abortSignal: AbortSignal;
  /** For structured logs: pod identity that won the claim. */
  workerId: string;
}

export type JobHandler = (
  ctx: JobContext,
) => Promise<Record<string, unknown> | void>;

export interface RegisteredHandler {
  jobType: JobType;
  handler: JobHandler;
  /** Per-claim lease TTL — should be longer than typical handler runtime. */
  ttlSeconds: number;
  /** Max attempts before terminal-fail. */
  maxAttempts: number;
  /**
   * Route to JobWorkerPool instead of running in-thread. Required
   * companion: workerModule pointing at a CommonJS module that
   * exports `run(input): Promise<output>`.
   */
  cpuBound?: boolean;
  workerModule?: string;
}

/** Leader/lifecycle control surface the poller reads on each cycle. */
export interface PollControl {
  isLeader: () => boolean;
  signal: AbortSignal;
}
