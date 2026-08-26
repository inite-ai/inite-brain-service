/**
 * Unit coverage for the 0107 outcome-telemetry write seam:
 *   * recordOutcomes — master-flag guard, dedupe + cap, the 'auto'
 *     event→counter mapping, explicit signed statDeltas, and the two
 *     batched statements' shape;
 *   * OutcomePruneService — batch-loop termination + the prune query
 *     shape (bounded DELETE-subquery with RETURN BEFORE).
 */
import {
  MemoryOutcomeService,
  OUTCOME_RECORD_CAP,
  autoStatDeltas,
  dedupeOutcomeEvents,
  type OutcomeEventInput,
} from '../src/outcomes/memory-outcome.service';
import {
  OUTCOME_PRUNE_BATCH_QUERY,
  OutcomePruneService,
} from '../src/outcomes/outcome-prune.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

interface CapturedQuery {
  sql: string;
  params: Record<string, unknown>;
}

function makeSurreal(captured: CapturedQuery[], results: unknown[][] = []) {
  let call = 0;
  const db = {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      captured.push({ sql, params });
      return [results[call++] ?? []];
    },
  };
  return {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
}

/** The detached write is fire-and-forget — yield until it lands. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const ev = (
  subjectId: string,
  event: OutcomeEventInput['event'],
  extra: Partial<OutcomeEventInput> = {},
): OutcomeEventInput => ({ subjectKind: 'fact', subjectId, event, ...extra });

describe('MemoryOutcomeService.recordOutcomes', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  it('is a no-op with the master flag off (byte-identical)', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({ companyId: 'co_x', events: [ev('knowledge_fact:a', 'used_in_answer')] });
    await flush();
    expect(captured).toEqual([]);
    expect(MemoryOutcomeService.enabled()).toBe(false);
  });

  it("'auto' maps each event to its counter — and `retrieved` to NO stat row", async () => {
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({
      companyId: 'co_x',
      events: [
        ev('knowledge_fact:a', 'selected_for_context'),
        ev('knowledge_fact:a', 'used_in_answer'),
        ev('knowledge_fact:a', 'verifier_supported'),
        ev('knowledge_fact:b', 'user_confirmed'),
        ev('knowledge_fact:b', 'user_rejected'),
        ev('knowledge_fact:c', 'contradicted'),
        ev('knowledge_fact:d', 'retrieved'),
      ],
    });
    await flush();
    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    // Two batched statements in one round-trip.
    expect(sql).toContain('INSERT INTO memory_outcome $rows');
    expect(sql).toContain('INSERT INTO memory_outcome_stat $statRows');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    const rows = params.rows as Array<{ subjectId: unknown; event: string }>;
    expect(rows).toHaveLength(7);
    const statRows = params.statRows as Array<Record<string, unknown>>;
    const byId = new Map(statRows.map((r) => [String(r.subjectId), r]));
    // fact:d only carried `retrieved` → no rollup row at all.
    expect(byId.has('knowledge_fact:d')).toBe(false);
    expect(byId.get('knowledge_fact:a')).toMatchObject({
      selectedCount: 1,
      usedCount: 1,
      verifiedUseCount: 1,
      confirmedCount: 0,
    });
    expect((byId.get('knowledge_fact:a') as { lastUsedAt?: Date }).lastUsedAt).toBeInstanceOf(Date);
    expect(
      (byId.get('knowledge_fact:a') as { lastVerifiedUseAt?: Date }).lastVerifiedUseAt,
    ).toBeInstanceOf(Date);
    expect(byId.get('knowledge_fact:b')).toMatchObject({ confirmedCount: 1, rejectedCount: 1 });
    // user_confirmed counts as a verified use.
    expect(
      (byId.get('knowledge_fact:b') as { lastVerifiedUseAt?: Date }).lastVerifiedUseAt,
    ).toBeInstanceOf(Date);
    expect(byId.get('knowledge_fact:c')).toMatchObject({ contradictedCount: 1 });
  });

  it('dedupes on (kind, subject, event, actor) and caps at OUTCOME_RECORD_CAP', async () => {
    const dup = [
      ev('knowledge_fact:a', 'used_in_answer'),
      ev('knowledge_fact:a', 'used_in_answer'),
    ];
    expect(dedupeOutcomeEvents(dup)).toHaveLength(1);
    // Distinct actors are NOT dupes (feedback: one row per voting key).
    expect(
      dedupeOutcomeEvents([
        ev('knowledge_fact:a', 'user_confirmed', { actor: 'k1' }),
        ev('knowledge_fact:a', 'user_confirmed', { actor: 'k2' }),
      ]),
    ).toHaveLength(2);
    const many = Array.from({ length: OUTCOME_RECORD_CAP + 50 }, (_, i) =>
      ev(`knowledge_fact:f${i}`, 'retrieved'),
    );
    expect(dedupeOutcomeEvents(many)).toHaveLength(OUTCOME_RECORD_CAP);

    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({ companyId: 'co_x', events: many });
    await flush();
    expect((captured[0]!.params.rows as unknown[]).length).toBe(OUTCOME_RECORD_CAP);
  });

  it('explicit signed statDeltas aggregate per subject (replace = −1 old / +1 new)', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({
      companyId: 'co_x',
      events: [ev('knowledge_fact:a', 'user_rejected', { actor: 'k1' })],
      statDeltas: [
        {
          subjectKind: 'fact',
          subjectId: 'knowledge_fact:a',
          counter: 'confirmedCount',
          delta: -1,
        },
        { subjectKind: 'fact', subjectId: 'knowledge_fact:a', counter: 'rejectedCount', delta: 1 },
      ],
    });
    await flush();
    const statRows = captured[0]!.params.statRows as Array<Record<string, unknown>>;
    expect(statRows).toHaveLength(1);
    expect(statRows[0]).toMatchObject({ confirmedCount: -1, rejectedCount: 1, usedCount: 0 });
  });

  it('emits only the stat statement when events are empty but deltas move', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    // A helpful → not_helpful flip: no raw event, standing vote leaves
    // its bucket.
    svc.recordOutcomes({
      companyId: 'co_x',
      events: [],
      statDeltas: [
        {
          subjectKind: 'fact',
          subjectId: 'knowledge_fact:a',
          counter: 'confirmedCount',
          delta: -1,
        },
      ],
    });
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).not.toContain('INSERT INTO memory_outcome $rows');
    expect(captured[0]!.sql).toContain('INSERT INTO memory_outcome_stat');
  });

  it("the 'auto' mapping helper leaves `retrieved` unmapped", () => {
    const now = new Date();
    expect(autoStatDeltas([ev('knowledge_fact:a', 'retrieved')], now)).toEqual([]);
    expect(autoStatDeltas([ev('knowledge_fact:a', 'selected_for_context')], now)).toMatchObject([
      { counter: 'selectedCount', delta: 1 },
    ]);
  });
});

describe('OutcomePruneService', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  const apiKeys = (ids: string[]) => ({ knownCompanyIds: () => ids }) as unknown as ApiKeyService;

  it('prune query is the bounded DELETE-subquery shape', () => {
    expect(OUTCOME_PRUNE_BATCH_QUERY).toBe(
      'DELETE (SELECT id FROM memory_outcome WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE',
    );
  });

  it('loops full batches and stops on the partial one', async () => {
    const captured: CapturedQuery[] = [];
    const surreal = makeSurreal(captured, [new Array(5000).fill({}), new Array(3).fill({})]);
    const svc = new OutcomePruneService(surreal, apiKeys(['co_x']));
    const total = await svc.pruneTenant('co_x');
    expect(total).toBe(5003);
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => c.sql === OUTCOME_PRUNE_BATCH_QUERY)).toBe(true);
    expect(captured[0]!.params.cutoff).toBeInstanceOf(Date);
  });

  it('runNightly is gated on the master flag', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    const captured: CapturedQuery[] = [];
    const svc = new OutcomePruneService(makeSurreal(captured), apiKeys(['co_x']));
    expect(await svc.runNightly()).toEqual({ tenants: 0, pruned: 0 });
    expect(captured).toEqual([]);
  });

  it('runNightly walks the tenant roster when on', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new OutcomePruneService(makeSurreal(captured, [[], []]), apiKeys(['co_a', 'co_b']));
    expect(await svc.runNightly()).toEqual({ tenants: 2, pruned: 0 });
    expect(captured).toHaveLength(2);
  });
});
