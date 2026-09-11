/**
 * Read side of the 0119 decision stream.
 *
 * The table shipped with a writer, three indexes and a retention cron,
 * and no reader — so these gates are about the two things that make a
 * reader worth having: it must not widen the content-free contract, and
 * its aggregate must be honest about a truncated scan.
 */
import { BadRequestException } from '@nestjs/common';
import { MemoryDecisionsReadService } from '../src/outcomes/memory-decisions-read.service';
import type { SurrealService } from '../src/db/surreal.service';

interface Captured {
  sql: string;
  params: Record<string, unknown>;
}

function makeSurreal(captured: Captured[], rows: unknown[] = []): SurrealService {
  return {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql: string, params: Record<string, unknown> = {}) => {
          captured.push({ sql, params });
          return [rows];
        },
      }),
  } as unknown as SurrealService;
}

const row = (over: Record<string, unknown> = {}) => ({
  decisionId: 'd1',
  decisionKind: 'abstain',
  policyVersion: 'static',
  chosenAction: 'abstain',
  createdAt: new Date('2026-09-10T12:00:00.000Z'),
  ...over,
});

describe('MemoryDecisionsReadService.feed', () => {
  it('orders by createdAt and pages with a cursor only when more rows exist', async () => {
    const captured: Captured[] = [];
    const rows = [row({ decisionId: 'a' }), row({ decisionId: 'b' }), row({ decisionId: 'c' })];
    const svc = new MemoryDecisionsReadService(makeSurreal(captured, rows));

    const res = await svc.feed('co', { limit: 2 });

    expect(captured[0]!.sql).toContain('ORDER BY createdAt DESC');
    // limit + 1 is how "is there another page" is answered without a count.
    expect(captured[0]!.params.limit).toBe(3);
    expect(res.decisions.map((d) => d.decisionId)).toEqual(['a', 'b']);
    expect(res.nextCursor).toBe('2026-09-10T12:00:00.000Z');
  });

  it('omits the cursor on the last page', async () => {
    const svc = new MemoryDecisionsReadService(makeSurreal([], [row()]));
    const res = await svc.feed('co', { limit: 5 });
    expect(res.decisions).toHaveLength(1);
    expect(res.nextCursor).toBeUndefined();
  });

  it('pulls one request whole decision chain through the requestId index', async () => {
    const captured: Captured[] = [];
    const svc = new MemoryDecisionsReadService(makeSurreal(captured, [row()]));
    await svc.feed('co', { requestId: 'req-7' });
    expect(captured[0]!.sql).toContain('requestId = $requestId');
    expect(captured[0]!.params.requestId).toBe('req-7');
  });

  it('refuses a decisionKind outside the migration enum instead of querying', async () => {
    const captured: Captured[] = [];
    const svc = new MemoryDecisionsReadService(makeSurreal(captured));
    await expect(svc.feed('co', { decisionKind: 'made_up' })).rejects.toThrow(BadRequestException);
    expect(captured).toEqual([]);
  });

  it('refuses a non-ISO cursor instead of querying', async () => {
    const captured: Captured[] = [];
    const svc = new MemoryDecisionsReadService(makeSurreal(captured));
    await expect(svc.feed('co', { before: 'yesterday' })).rejects.toThrow(BadRequestException);
    expect(captured).toEqual([]);
  });

  it('never carries a non-number, non-string value out of observedState', async () => {
    // 0119 declares observedState FLEXIBLE, so the read side cannot
    // assume the writer's whitelist held for every row already stored.
    const svc = new MemoryDecisionsReadService(
      makeSurreal(
        [],
        [
          row({
            observedState: {
              topScore: 0.4,
              queryClass: 'temporal',
              leaked: { note: 'free text' },
              alsoLeaked: ['a'],
              nan: Number.NaN,
            },
          }),
        ],
      ),
    );
    const [d] = (await svc.feed('co', {})).decisions;
    expect(d!.observedState).toEqual({ topScore: 0.4, queryClass: 'temporal' });
  });

  it('drops malformed alternatives rather than serving half a pair', async () => {
    const svc = new MemoryDecisionsReadService(
      makeSurreal(
        [],
        [
          row({
            alternatives: [
              { action: 'escalate', score: 0.7 },
              { action: 'proceed' },
              { score: 0.1 },
            ],
          }),
        ],
      ),
    );
    const [d] = (await svc.feed('co', {})).decisions;
    expect(d!.alternatives).toEqual([{ action: 'escalate', score: 0.7 }]);
  });
});

describe('MemoryDecisionsReadService.stats', () => {
  it('groups by (kind, action) and averages only the costs that are present', async () => {
    const rows = [
      row({ chosenAction: 'abstain', costs: { latencyMs: 100 } }),
      row({ chosenAction: 'abstain', costs: { latencyMs: 200, promptTokens: 50 } }),
      row({ decisionKind: 'l3_escalation', chosenAction: 'escalate' }),
    ];
    const svc = new MemoryDecisionsReadService(makeSurreal([], rows));
    const res = await svc.stats('co', 7);

    const abstain = res.byAction.find((a) => a.chosenAction === 'abstain');
    expect(abstain).toMatchObject({ count: 2, avgLatencyMs: 150, avgPromptTokens: 50 });
    // Averaged over the rows that HAVE the cost, not over all rows —
    // otherwise a partially-instrumented seam reads as cheaper than it is.
    const escalate = res.byAction.find((a) => a.chosenAction === 'escalate');
    expect(escalate!.avgLatencyMs).toBeUndefined();
  });

  it('reports the sample size and says when the scan was truncated', async () => {
    const svc = new MemoryDecisionsReadService(makeSurreal([], [row(), row()]));
    const res = await svc.stats('co', 7);
    expect(res.sampled).toBe(2);
    // A capped scan read as a whole window is how a "trend" gets invented.
    expect(res.truncated).toBe(false);
  });

  it('clamps the window to the retention range', async () => {
    const captured: Captured[] = [];
    const svc = new MemoryDecisionsReadService(makeSurreal(captured));
    await svc.stats('co', 9999);
    expect(captured[0]!.sql).toContain('time::now() - 30d');
  });

  it('buckets the series by day and counts per kind', async () => {
    const rows = [
      row({ createdAt: new Date('2026-09-10T01:00:00Z') }),
      row({ createdAt: new Date('2026-09-10T23:00:00Z'), decisionKind: 'zoom' }),
      row({ createdAt: new Date('2026-09-11T01:00:00Z') }),
    ];
    const svc = new MemoryDecisionsReadService(makeSurreal([], rows));
    const res = await svc.stats('co', 7);
    expect(res.series).toEqual([
      { day: '2026-09-10', counts: { abstain: 1, zoom: 1 } },
      { day: '2026-09-11', counts: { abstain: 1 } },
    ]);
  });

  it('counts policy versions — the axis a policy change is read on', async () => {
    const rows = [
      row({ policyVersion: 'static' }),
      row({ policyVersion: 'adaptive@thr=0.5', decisionKind: 'l3_escalation' }),
      row({ policyVersion: 'adaptive@thr=0.5' }),
    ];
    const svc = new MemoryDecisionsReadService(makeSurreal([], rows));
    const res = await svc.stats('co', 7);
    expect(res.byPolicyVersion[0]).toMatchObject({
      policyVersion: 'adaptive@thr=0.5',
      count: 2,
    });
    expect(res.byPolicyVersion[0]!.kinds.sort()).toEqual(['abstain', 'l3_escalation']);
  });
});
