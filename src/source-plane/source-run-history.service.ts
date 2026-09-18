import { Injectable } from '@nestjs/common';
import type {
  SourceRun,
  SourceRunsResponse,
  SourceSyncSummary,
} from '../contracts/source-plane/source-plane.schema';
import { SurrealService, queryRows } from '../db/surreal.service';
import { JobRunService, type JobRunRow } from '../jobs/job-run.service';
import { SourceSyncService, type SyncOptions } from './source-sync.service';

/** Newest-first history page — the operator reads the last few runs, not an audit log. */
const HISTORY_MAX = 200;

/**
 * SourceRunHistoryService — every sync of a connection is one
 * `source_sync` job_run, whoever ran it: the queue (payload names the
 * connection), an agent (progress names it), or an operator watching
 * an inline run (this service starts the row so the run is not
 * invisible the way inline runs used to be). The history is the
 * job_run table read back by connection, projected to the counters
 * the operator reads.
 */
@Injectable()
export class SourceRunHistoryService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly jobs: JobRunService,
    private readonly sync: SourceSyncService,
  ) {}

  /**
   * Run a connection inline under a job_run of its own. The row is the
   * operator's receipt: it shows up in the Jobs cockpit and in the
   * connection's history like a queued run would; a sync that throws
   * still finishes the row (failed) before the error propagates.
   */
  async runInline(
    companyId: string,
    connectionId: string,
    opts: SyncOptions & { actor?: string | undefined },
  ): Promise<SourceSyncSummary> {
    const job = await this.jobs.start({
      jobType: 'source_sync',
      companyId,
      triggeredBy: 'manual',
      triggeredByActor: opts.actor ?? 'admin',
      initialProgress: { connectionId, inline: true, full: opts.full === true },
    });
    let summary: SourceSyncSummary;
    try {
      summary = await this.sync.sync(companyId, connectionId, { full: opts.full });
    } catch (err) {
      await this.jobs.finish(job, {
        status: 'failed',
        error: { message: (err as Error).message ?? String(err) },
      });
      throw err;
    }
    await this.jobs.finish(job, {
      status: summary.status === 'failed' ? 'failed' : 'succeeded',
      result: summary as unknown as Record<string, unknown>,
      ...(summary.error ? { error: { message: summary.error } } : {}),
    });
    return summary;
  }

  async list(companyId: string, connectionId: string, limit: number): Promise<SourceRunsResponse> {
    if (!this.jobs.persistEnabled) return { connectionId, persisted: false, runs: [] };
    const lim = Math.min(Math.max(limit, 1), HISTORY_MAX);
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<JobRunRow>(
        db,
        // One row per run; the three writers name the connection in three
        // places (queue payload, agent progress, everyone's result).
        `SELECT runId, status, triggeredBy, triggeredByActor, startedAt, finishedAt, progress, result, error
           FROM job_run
          WHERE jobType = 'source_sync'
            AND (payload.connectionId = $id OR progress.connectionId = $id OR result.connectionId = $id)
          ORDER BY startedAt DESC LIMIT ${lim}`,
        { id: connectionId },
      ),
    );
    return { connectionId, persisted: true, runs: rows.map(toSourceRun) };
  }
}

const COUNTER_KEYS = [
  'seen',
  'new',
  'changed',
  'unchanged',
  'gone',
  'fetched',
  'ingested',
  'deduplicated',
  'failed',
  'closed',
] as const;

export function toSourceRun(row: JobRunRow): SourceRun {
  const result = (row.result ?? null) as Partial<SourceSyncSummary> | null;
  const progress = (row.progress ?? null) as Record<string, unknown> | null;
  const counters =
    result ?? (progress?.['counters'] as Record<string, unknown> | undefined) ?? null;
  const startedAt = toIso(row.startedAt) ?? new Date(0).toISOString();
  const finishedAt = toIso(row.finishedAt);
  const actor = row.triggeredByActor ?? null;
  return {
    runId: row.runId,
    status: row.status,
    ranBy: actor && (actor.startsWith('agent:') || actor.startsWith('webhook:')) ? actor : 'server',
    triggeredBy: row.triggeredBy,
    startedAt,
    finishedAt,
    durationMs:
      typeof result?.durationMs === 'number'
        ? result.durationMs
        : finishedAt
          ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
          : null,
    mode: modeOf({ actor, result, progress }),
    counters: counters ? countersOf(counters) : null,
    skipped: typeof result?.skipped === 'string' ? result.skipped : null,
    error: row.error?.message ?? (typeof result?.error === 'string' ? result.error : null),
  };
}

/** A webhook batch (the actor, the result's `ranBy`, or the inline receipt's progress says so), else the walk's mode. */
function modeOf(p: {
  actor: string | null;
  result: Partial<SourceSyncSummary> | null;
  progress: Record<string, unknown> | null;
}): SourceRun['mode'] {
  const { actor, result, progress } = p;
  const webhook =
    (actor?.startsWith('webhook:') ?? false) ||
    (result as { ranBy?: unknown } | null)?.ranBy === 'webhook' ||
    progress?.['webhook'] !== undefined;
  if (webhook) return 'webhook';
  if (result?.mode === 'full' || result?.mode === 'incremental') return result.mode;
  if (progress && typeof progress['full'] === 'boolean')
    return progress['full'] ? 'full' : 'incremental';
  return null;
}

function countersOf(raw: Record<string, unknown>): SourceRun['counters'] {
  const out = {} as Record<(typeof COUNTER_KEYS)[number], number>;
  for (const k of COUNTER_KEYS) {
    const v = raw[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return out;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
