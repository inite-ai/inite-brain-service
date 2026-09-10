import { BadRequestException } from '@nestjs/common';

/**
 * Terminal status of a batch operation. `complete` — every unit landed and
 * every post-pass ran clean; `degraded` — some units failed, or a post-pass
 * over landed units failed; `failed` — units were attempted and none
 * succeeded, or the operation could not run at all. A log line never
 * replaces this: callers branch on `status`, and `failed[].key` is what a
 * retry selector (`keys`) accepts.
 */
export type BatchStatus = 'complete' | 'degraded' | 'failed';

export interface BatchFailure {
  /** The unit's retry key (conversation id, asset id, table, entity id);
   *  `*` names the operation itself when it could not run. */
  key: string;
  error: string;
}

export interface BatchOutcome {
  status: BatchStatus;
  /** Units attempted. */
  total: number;
  succeeded: number;
  /** Units that failed — retryable by key. */
  failed: BatchFailure[];
  /**
   * Failures that degrade the batch without failing a unit: a post-pass
   * over landed units, or a nested batch that itself degraded. Not
   * retryable by unit key — re-run the named pass.
   */
  degradedBy: BatchFailure[];
}

/** Key prefix for post-pass entries in `degradedBy`. */
export const POST_PASS_KEY = 'post-pass:';

/** Longest error text an outcome carries per entry. */
const ERROR_MAX = 500;

export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, ERROR_MAX);
}

/** Fold unit results and post-pass failures into a terminal status. */
export function foldBatchOutcome(units: {
  total: number;
  succeeded: number;
  failed: BatchFailure[];
  degradedBy?: BatchFailure[];
}): BatchOutcome {
  const degradedBy = units.degradedBy ?? [];
  let status: BatchStatus = 'complete';
  if (units.failed.length > 0 && units.succeeded === 0) status = 'failed';
  else if (units.failed.length > 0 || degradedBy.length > 0) status = 'degraded';
  return {
    status,
    total: units.total,
    succeeded: units.succeeded,
    failed: units.failed,
    degradedBy,
  };
}

/** A batch that attempted nothing and failed nothing. */
export function emptyBatchOutcome(): BatchOutcome {
  return foldBatchOutcome({ total: 0, succeeded: 0, failed: [] });
}

/** The operation could not run at all (key `*`, no units attempted). */
export function failedBatchOutcome(error: string, key = '*'): BatchOutcome {
  return { status: 'failed', total: 0, succeeded: 0, failed: [{ key, error }], degradedBy: [] };
}

/**
 * Fold nested batches (one per tenant, per asset, …) into one outcome. A
 * failed part is a failed unit; a degraded part degrades the whole; a
 * complete part succeeded.
 */
export function foldNestedOutcomes(
  parts: ReadonlyArray<{ key: string; outcome: BatchOutcome }>,
): BatchOutcome {
  const failed: BatchFailure[] = [];
  const degradedBy: BatchFailure[] = [];
  let succeeded = 0;
  for (const part of parts) {
    if (part.outcome.status === 'failed') {
      failed.push({ key: part.key, error: describeBatchOutcome(part.outcome) });
    } else {
      succeeded += 1;
      if (part.outcome.status === 'degraded') {
        degradedBy.push({ key: part.key, error: describeBatchOutcome(part.outcome) });
      }
    }
  }
  return foldBatchOutcome({ total: parts.length, succeeded, failed, degradedBy });
}

/** One-line summary for logs and job_run error messages. */
export function describeBatchOutcome(outcome: BatchOutcome): string {
  const head = `${outcome.status}: ${outcome.succeeded} of ${outcome.total} unit(s) succeeded`;
  const first = outcome.failed[0] ?? outcome.degradedBy[0];
  if (!first) return head;
  const counts =
    `${outcome.failed.length} failed` +
    (outcome.degradedBy.length > 0 ? `, ${outcome.degradedBy.length} degrading` : '');
  return `${head} (${counts}); first: ${first.key} — ${first.error}`;
}

/** The `outcome` a job handler's result carries, when it carries one. */
export function batchOutcomeOf(result: unknown): BatchOutcome | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const outcome = (result as { outcome?: unknown }).outcome;
  if (outcome === null || typeof outcome !== 'object') return undefined;
  const o = outcome as Partial<BatchOutcome>;
  const statusOk = o.status === 'complete' || o.status === 'degraded' || o.status === 'failed';
  return statusOk && Array.isArray(o.failed) ? (o as BatchOutcome) : undefined;
}

/**
 * Parse an admin body's optional `keys` retry selector: absent ⇒
 * undefined; otherwise a non-empty, bounded array of trimmed non-empty
 * strings, each passing `accept` (400 otherwise).
 */
export function parseBatchKeys(
  raw: unknown,
  opts: { maxKeys: number; maxLength: number; accept?: (key: string) => boolean },
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > opts.maxKeys) {
    throw new BadRequestException(`keys must be a non-empty array of at most ${opts.maxKeys}`);
  }
  const keys = raw.map((k) => (typeof k === 'string' ? k.trim() : ''));
  const bad = keys.find(
    (k) => k === '' || k.length > opts.maxLength || (opts.accept !== undefined && !opts.accept(k)),
  );
  if (bad !== undefined) throw new BadRequestException(`keys contains an invalid entry`);
  return [...new Set(keys)];
}
