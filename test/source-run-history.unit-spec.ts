/**
 * The run-history projection: one `source_sync` job_run row, whoever
 * wrote it (queue: payload + result; agent: progress, then result;
 * inline: progress + result), reads as the same SourceRun.
 */
import type { JobRunRow } from '../src/jobs/job-run.service';
import { toSourceRun } from '../src/source-plane/source-run-history.service';

const base: JobRunRow = {
  runId: 'r1',
  jobType: 'source_sync',
  status: 'succeeded',
  triggeredBy: 'manual',
  startedAt: '2026-09-17T10:00:00.000Z',
  finishedAt: '2026-09-17T10:00:02.500Z',
  cancelRequested: false,
  companyId: 'co',
};

describe('toSourceRun', () => {
  it('a queued run: counters and mode from the result, ran by the server', () => {
    const run = toSourceRun({
      ...base,
      triggeredBy: 'cron',
      payload: { connectionId: 'source_connection:a', full: false },
      result: {
        connectionId: 'source_connection:a',
        mode: 'incremental',
        status: 'succeeded',
        seen: 10,
        new: 1,
        changed: 2,
        unchanged: 7,
        gone: 0,
        fetched: 3,
        ingested: 2,
        deduplicated: 1,
        failed: 0,
        closed: 0,
        durationMs: 1234,
      },
    });
    expect(run).toMatchObject({
      runId: 'r1',
      status: 'succeeded',
      ranBy: 'server',
      triggeredBy: 'cron',
      mode: 'incremental',
      durationMs: 1234,
      counters: {
        seen: 10,
        new: 1,
        changed: 2,
        unchanged: 7,
        fetched: 3,
        ingested: 2,
        deduplicated: 1,
      },
      skipped: null,
      error: null,
    });
  });

  it('an agent run still running: live counters from progress, ran by the agent, no duration yet', () => {
    const run = toSourceRun({
      ...base,
      status: 'running',
      finishedAt: null,
      triggeredByActor: 'agent:laptop',
      progress: {
        connectionId: 'source_connection:a',
        agentId: 'laptop',
        full: true,
        counters: { seen: 4, new: 4, changed: 0, unchanged: 0, gone: 0, fetched: 1, ingested: 1 },
      },
    });
    expect(run).toMatchObject({
      status: 'running',
      ranBy: 'agent:laptop',
      mode: 'full',
      finishedAt: null,
      durationMs: null,
      counters: { seen: 4, new: 4, fetched: 1, ingested: 1, deduplicated: 0, failed: 0, closed: 0 },
    });
  });

  it('a failed run carries the job error; a skipped summary names why; no counters before the first delta', () => {
    const failed = toSourceRun({
      ...base,
      status: 'failed',
      error: { message: 'root is outside SOURCE_FS_ROOTS' },
      result: {
        connectionId: 'source_connection:a',
        mode: 'full',
        status: 'failed',
        error: 'root is outside SOURCE_FS_ROOTS',
      },
    });
    expect(failed.error).toBe('root is outside SOURCE_FS_ROOTS');
    expect(failed.counters).toMatchObject({ seen: 0, fetched: 0 });
    expect(failed.durationMs).toBe(2500);

    const skipped = toSourceRun({
      ...base,
      result: {
        connectionId: 'source_connection:a',
        mode: 'incremental',
        status: 'skipped',
        skipped: 'status_paused',
      },
    });
    expect(skipped.skipped).toBe('status_paused');

    const bare = toSourceRun({
      ...base,
      status: 'running',
      finishedAt: null,
      progress: { connectionId: 'x' },
    });
    expect(bare.counters).toBeNull();
    expect(bare.mode).toBeNull();
  });
});
