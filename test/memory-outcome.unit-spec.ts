/**
 * Unit coverage for the 0107 outcome-telemetry write seam:
 *   * recordOutcomes — master-flag guard, dedupe + cap, the 'auto'
 *     event→counter mapping, explicit signed statDeltas, and the two
 *     batched statements' shape;
 *   * OUTCOME_TX_WRITES — flag-off BYTE-IDENTITY against literal SQL
 *     (copied from origin/main, NOT from the implementation constants),
 *     the deterministic event-id derivation, the one-BEGIN/COMMIT tx
 *     shape, per-delta gating, and the single-OCC-retry contract;
 *   * OutcomePruneService — batch-loop termination + the prune query
 *     shapes (bounded DELETE-subquery with RETURN BEFORE), incl. the
 *     0119 memory_decision leg.
 */
import {
  MemoryOutcomeService,
  OUTCOME_RECORD_CAP,
  autoStatDeltas,
  dedupeOutcomeEvents,
  outcomeDedupeKey,
  outcomeEventId,
  type OutcomeEventInput,
} from '../src/outcomes/memory-outcome.service';
import { buildOutcomeTxPayload } from '../src/outcomes/outcome-tx';
import {
  DECISION_PRUNE_BATCH_QUERY,
  OUTCOME_PRUNE_BATCH_QUERY,
  OutcomePruneService,
} from '../src/outcomes/outcome-prune.service';
import { runWithRequestContext } from '../src/common/request-context';
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

  // ── 0113 modality dimensions ──────────────────────────────────────
  describe('0113 modality dimensions', () => {
    it('dedupe partitioning pin: legacy (no-dimension) events partition exactly as before', () => {
      // Same legacy pair that deduped to 1 pre-0113 — the appended
      // constant `||` key suffix must not change the partitioning.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'used_in_answer'),
          ev('knowledge_fact:a', 'used_in_answer'),
        ]),
      ).toHaveLength(1);
      // Distinct actors still partition.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'user_confirmed', { actor: 'k1' }),
          ev('knowledge_fact:a', 'user_confirmed', { actor: 'k2' }),
        ]),
      ).toHaveLength(2);
    });

    it('dedupe: modality/representationKind SPLIT otherwise-identical events', () => {
      // Same event on different modalities = two rows.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'used_in_answer', { modality: 'visual' }),
          ev('knowledge_fact:a', 'used_in_answer', { modality: 'audio' }),
        ]),
      ).toHaveLength(2);
      // Dimensioned vs legacy (absent = legacy/text) = two rows.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'used_in_answer', { modality: 'visual' }),
          ev('knowledge_fact:a', 'used_in_answer'),
        ]),
      ).toHaveLength(2);
      // Same modality, different representationKind = two rows.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'used_in_answer', {
            modality: 'visual',
            representationKind: 'caption',
          }),
          ev('knowledge_fact:a', 'used_in_answer', {
            modality: 'visual',
            representationKind: 'ocr_text',
          }),
        ]),
      ).toHaveLength(2);
      // True duplicates (same dimensions) still collapse.
      expect(
        dedupeOutcomeEvents([
          ev('knowledge_fact:a', 'used_in_answer', { modality: 'visual' }),
          ev('knowledge_fact:a', 'used_in_answer', { modality: 'visual' }),
        ]),
      ).toHaveLength(1);
    });

    it('INSERT row for an existing (no-dimension) writer is byte-identical — no new keys', async () => {
      const captured: CapturedQuery[] = [];
      const svc = new MemoryOutcomeService(makeSurreal(captured));
      svc.recordOutcomes({
        companyId: 'co_x',
        events: [ev('knowledge_fact:a', 'used_in_answer', { actor: 'k1' })],
        requestId: 'req-1',
      });
      await flush();
      const rows = captured[0]!.params.rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      // The EXACT pre-0113 key set — modality/representationKind absent
      // (undefined → dropped → NONE), so legacy writers stay byte-identical.
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'actor',
        'createdAt',
        'event',
        'requestId',
        'subjectId',
        'subjectKind',
      ]);
    });

    it('a dimensioned event threads modality + representationKind onto the raw row (rollup untouched)', async () => {
      const captured: CapturedQuery[] = [];
      const svc = new MemoryOutcomeService(makeSurreal(captured));
      svc.recordOutcomes({
        companyId: 'co_x',
        events: [
          ev('knowledge_fact:a', 'used_in_answer', {
            modality: 'visual',
            representationKind: 'caption',
          }),
        ],
      });
      await flush();
      const rows = captured[0]!.params.rows as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({ modality: 'visual', representationKind: 'caption' });
      // The rollup stays UNIQUE-per-subject with NO per-modality columns
      // (deliberately deferred — no scorer consumes them; raw rows retain
      // full dimensionality).
      const statRows = captured[0]!.params.statRows as Array<Record<string, unknown>>;
      expect(statRows).toHaveLength(1);
      expect(Object.keys(statRows[0]!)).not.toContain('modality');
      expect(Object.keys(statRows[0]!)).not.toContain('representationKind');
    });
  });
});

// ── OUTCOME_TX_WRITES (0119 wave) ───────────────────────────────────
describe('OUTCOME_TX_WRITES', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.OUTCOME_TX_WRITES;
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  // The legacy statements, copied as LITERALS from origin/main —
  // deliberately NOT imported from the implementation, so a drift in the
  // off path fails here even if the implementation's own constants
  // drifted with it.
  const LEGACY_RAW_SQL = 'INSERT INTO memory_outcome $rows';
  const LEGACY_STAT_SQL =
    'INSERT INTO memory_outcome_stat $statRows\n' +
    '           ON DUPLICATE KEY UPDATE\n' +
    '             selectedCount += $input.selectedCount,\n' +
    '             usedCount += $input.usedCount,\n' +
    '             verifiedUseCount += $input.verifiedUseCount,\n' +
    '             confirmedCount += $input.confirmedCount,\n' +
    '             rejectedCount += $input.rejectedCount,\n' +
    '             contradictedCount += $input.contradictedCount,\n' +
    '             lastUsedAt = $input.lastUsedAt ?? lastUsedAt,\n' +
    '             lastVerifiedUseAt = $input.lastVerifiedUseAt ?? lastVerifiedUseAt,\n' +
    '             updatedAt = time::now()';

  it('flag OFF: the write is byte-identical to the legacy two-statement shape', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({
      companyId: 'co_x',
      events: [ev('knowledge_fact:a', 'used_in_answer', { actor: 'k1' })],
      requestId: 'req-1',
    });
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toBe(`${LEGACY_RAW_SQL};\n${LEGACY_STAT_SQL}`);
    expect(Object.keys(captured[0]!.params).sort()).toEqual(['rows', 'statRows']);
    // No tx-only keys leak onto the off-path rows (no id, no decisionId).
    const row = (captured[0]!.params.rows as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(row)).not.toContain('id');
    expect(Object.keys(row)).not.toContain('decisionId');
  });

  it('outcomeEventId is deterministic on (key, scope, seq) and distinct across seq', () => {
    const key = outcomeDedupeKey(ev('knowledge_fact:a', 'used_in_answer'));
    expect(outcomeEventId(key, 'scope-1', 0)).toBe(outcomeEventId(key, 'scope-1', 0));
    expect(outcomeEventId(key, 'scope-1', 0)).toMatch(/^[0-9a-f]{32}$/);
    expect(outcomeEventId(key, 'scope-1', 0)).not.toBe(outcomeEventId(key, 'scope-1', 1));
    expect(outcomeEventId(key, 'scope-1', 0)).not.toBe(outcomeEventId(key, 'scope-2', 0));
  });

  it('flag ON: ONE BEGIN/COMMIT query with the pre-select / INSERT IGNORE / gated FOR legs', async () => {
    process.env.OUTCOME_TX_WRITES = '1';
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    svc.recordOutcomes({
      companyId: 'co_x',
      events: [ev('knowledge_fact:a', 'used_in_answer')],
      requestId: 'req-tx-1',
    });
    await flush();
    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql.startsWith('BEGIN TRANSACTION;\n')).toBe(true);
    expect(sql).toContain('LET $existing = (SELECT VALUE id FROM memory_outcome');
    expect(sql).toContain('INSERT IGNORE INTO memory_outcome $rows');
    expect(sql).toContain('rawId NOTINSIDE $existing OR rawId IS NONE');
    expect(sql).toContain('FOR $d IN $newDeltas');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('COMMIT TRANSACTION;');
    expect(Object.keys(params).sort()).toEqual(['deltas', 'rawIds', 'rows']);
    // Rows carry explicit deterministic ids + the correlation id.
    const row = (params.rows as Array<Record<string, unknown>>)[0]!;
    expect(String(row.id)).toMatch(/^memory_outcome:[0-9a-f]{32}$/);
    expect(row.requestId).toBe('req-tx-1');
    // Every delta rides its producing event's raw id (the SQL-level
    // replay guarantee; the true replay assertion is the e2e).
    const deltas = params.deltas as Array<{ rawId?: unknown }>;
    expect(deltas).toHaveLength(1);
    expect(String(deltas[0]!.rawId)).toBe(String(row.id));
  });

  it('two dispatches of the SAME request replay the SAME ids (fresh context, same correlation id)', async () => {
    process.env.OUTCOME_TX_WRITES = '1';
    const idsOf = async (): Promise<string[]> => {
      const captured: CapturedQuery[] = [];
      const svc = new MemoryOutcomeService(makeSurreal(captured));
      // A FRESH context object per dispatch (the WeakMap seq restarts) with
      // the same correlation id — mirrors an upstream HTTP replay.
      runWithRequestContext({ correlationId: 'corr-replay' }, () =>
        svc.recordOutcomes({
          companyId: 'co_x',
          events: [ev('knowledge_fact:a', 'used_in_answer')],
        }),
      );
      await flush();
      return (captured[0]!.params.rawIds as unknown[]).map(String);
    };
    expect(await idsOf()).toEqual(await idsOf());
  });

  it('two batches in ONE request context stay distinct rows (batchSeq)', async () => {
    process.env.OUTCOME_TX_WRITES = '1';
    const captured: CapturedQuery[] = [];
    const svc = new MemoryOutcomeService(makeSurreal(captured));
    runWithRequestContext({ correlationId: 'corr-two-batches' }, () => {
      svc.recordOutcomes({
        companyId: 'co_x',
        events: [ev('knowledge_fact:a', 'retrieved')],
      });
      svc.recordOutcomes({
        companyId: 'co_x',
        events: [ev('knowledge_fact:a', 'retrieved')],
      });
    });
    await flush();
    expect(captured).toHaveLength(2);
    const first = (captured[0]!.params.rawIds as unknown[]).map(String);
    const second = (captured[1]!.params.rawIds as unknown[]).map(String);
    expect(first).not.toEqual(second);
  });

  it('delta gating: feedback-shaped explicit deltas inherit the matching-subject event id; unmatched stay ungated', () => {
    const now = new Date();
    const payload = buildOutcomeTxPayload({
      events: [ev('knowledge_fact:a', 'user_rejected', { actor: 'k1' })],
      statDeltas: [
        // The vote flip: both signed moves ride the vote's raw row.
        {
          subjectKind: 'fact',
          subjectId: 'knowledge_fact:a',
          counter: 'confirmedCount',
          delta: -1,
        },
        { subjectKind: 'fact', subjectId: 'knowledge_fact:a', counter: 'rejectedCount', delta: 1 },
        // No event for this subject in the batch → ungated (documented residual).
        { subjectKind: 'fact', subjectId: 'knowledge_fact:zzz', counter: 'usedCount', delta: 1 },
      ],
      now,
      requestScope: 'scope-gate',
      batchSeq: 0,
    })!;
    expect(payload.rawIds).toHaveLength(1);
    const eventId = String(payload.rawIds[0]);
    expect(payload.deltas).toHaveLength(3);
    expect(String(payload.deltas[0]!.rawId)).toBe(eventId);
    expect(String(payload.deltas[1]!.rawId)).toBe(eventId);
    expect(payload.deltas[2]!.rawId).toBeUndefined();
    // Per-delta rows carry all six counters with ONE signed non-zero move.
    expect(payload.deltas[0]!.row).toMatchObject({ confirmedCount: -1, rejectedCount: 0 });
    expect(payload.deltas[1]!.row).toMatchObject({ confirmedCount: 0, rejectedCount: 1 });
  });

  it("'auto' deltas carry the id of the event that produced them (1:1); `retrieved` maps to none", () => {
    const now = new Date();
    const payload = buildOutcomeTxPayload({
      events: [
        ev('knowledge_fact:a', 'selected_for_context'),
        ev('knowledge_fact:a', 'used_in_answer'),
        ev('knowledge_fact:b', 'retrieved'),
      ],
      statDeltas: 'auto',
      now,
      requestScope: 'scope-auto',
      batchSeq: 0,
    })!;
    expect(payload.rawIds).toHaveLength(3);
    expect(payload.deltas).toHaveLength(2); // retrieved → no delta
    expect(String(payload.deltas[0]!.rawId)).toBe(String(payload.rawIds[0]));
    expect(String(payload.deltas[1]!.rawId)).toBe(String(payload.rawIds[1]));
    expect(payload.deltas[0]!.row).toMatchObject({ selectedCount: 1, usedCount: 0 });
    expect(payload.deltas[1]!.row).toMatchObject({ selectedCount: 0, usedCount: 1 });
  });

  it('OCC abort → exactly ONE retry; non-retriable error → zero retries (warn only)', async () => {
    process.env.OUTCOME_TX_WRITES = '1';
    const runWith = async (firstError: string): Promise<number> => {
      let calls = 0;
      const db = {
        query: async () => {
          calls += 1;
          if (calls === 1) throw new Error(firstError);
          return [];
        },
      };
      const surreal = {
        withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
      } as unknown as SurrealService;
      const svc = new MemoryOutcomeService(surreal);
      svc.recordOutcomes({
        companyId: 'co_x',
        events: [ev('knowledge_fact:a', 'used_in_answer')],
        requestId: 'req-retry',
      });
      await flush();
      return calls;
    };
    await expect(
      runWith(
        'Failed to commit transaction due to a read or write conflict. This transaction can be retried',
      ),
    ).resolves.toBe(2);
    await expect(runWith('Parse error: unexpected token')).resolves.toBe(1);
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

  it('decision prune leg (0119): bounded DELETE-subquery shape', () => {
    expect(DECISION_PRUNE_BATCH_QUERY).toBe(
      'DELETE (SELECT id FROM memory_decision WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE',
    );
  });

  it('decision leg runs on OUTCOME_DECISION_CAPTURE alone (independent master)', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    process.env.OUTCOME_DECISION_CAPTURE = '1';
    try {
      const captured: CapturedQuery[] = [];
      const svc = new OutcomePruneService(makeSurreal(captured, [[]]), apiKeys(['co_x']));
      expect(await svc.runNightly()).toEqual({ tenants: 1, pruned: 0 });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.sql).toBe(DECISION_PRUNE_BATCH_QUERY);
      expect(captured[0]!.params.cutoff).toBeInstanceOf(Date);
    } finally {
      delete process.env.OUTCOME_DECISION_CAPTURE;
    }
  });
});
