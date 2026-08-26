/**
 * Unit coverage for the 0119 decision-context writer:
 *   * shapeDecisionRow — the observedState WHITELIST (unknown keys and
 *     non-finite numbers dropped, queryClass capped), the alternatives
 *     cap (8, action/score pairs only), cost int-bounding, string caps,
 *     and content-freedom (no free-text field survives the shaper);
 *   * decisionEventId — deterministic on (scope, kind, seq);
 *   * MemoryDecisionService.record — master-flag gating, the INSERT
 *     IGNORE + explicit deterministic record id, id replay semantics
 *     (fresh context + same correlation id ⇒ same id; same context ⇒
 *     kind-seq advances), and the fire-and-forget warn-not-throw
 *     contract.
 */
import {
  DECISION_ALTERNATIVES_CAP,
  DECISION_QUERY_CLASS_CAP,
  MemoryDecisionService,
  decisionEventId,
  shapeDecisionRow,
  type DecisionInput,
} from '../src/outcomes/memory-decision.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { SurrealService } from '../src/db/surreal.service';

interface CapturedQuery {
  sql: string;
  params: Record<string, unknown>;
}

function makeSurreal(captured: CapturedQuery[]) {
  const db = {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      captured.push({ sql, params });
      return [[]];
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

const baseInput: DecisionInput = {
  decisionKind: 'abstain',
  policyVersion: 'static',
  chosenAction: 'abstain',
};

describe('decisionEventId', () => {
  it('is deterministic on (scope, kind, seq) and distinct across each component', () => {
    expect(decisionEventId('scope-1', 'abstain', 0)).toBe(decisionEventId('scope-1', 'abstain', 0));
    expect(decisionEventId('scope-1', 'abstain', 0)).toMatch(/^[0-9a-f]{32}$/);
    expect(decisionEventId('scope-1', 'abstain', 0)).not.toBe(
      decisionEventId('scope-1', 'abstain', 1),
    );
    expect(decisionEventId('scope-1', 'abstain', 0)).not.toBe(
      decisionEventId('scope-1', 'l3_escalation', 0),
    );
    expect(decisionEventId('scope-1', 'abstain', 0)).not.toBe(
      decisionEventId('scope-2', 'abstain', 0),
    );
  });
});

describe('shapeDecisionRow', () => {
  const ctx = { decisionId: 'd'.repeat(32), companyId: 'co_x' };

  it('whitelists observedState: unknown keys and non-finite numbers are DROPPED', () => {
    const row = shapeDecisionRow(
      {
        ...baseInput,
        observedState: {
          topScore: 0.8,
          coverageScore: 0.5,
          retrievalGap: 0.2,
          rawConfidence: 0.6,
          candidateCount: 7,
          queryClass: 'temporal',
          // Everything below must be dropped — the content-free contract.
          query: 'what is the user password?',
          answerText: 'free text',
          nested: { deep: 1 },
          nan: Number.NaN,
          inf: Number.POSITIVE_INFINITY,
        },
      },
      ctx,
    );
    expect(row.observedState).toEqual({
      topScore: 0.8,
      coverageScore: 0.5,
      retrievalGap: 0.2,
      rawConfidence: 0.6,
      candidateCount: 7,
      queryClass: 'temporal',
    });
  });

  it('caps queryClass at 64 chars and drops an all-junk observedState entirely', () => {
    const long = shapeDecisionRow(
      { ...baseInput, observedState: { queryClass: 'x'.repeat(200) } },
      ctx,
    );
    expect((long.observedState!.queryClass as string).length).toBe(DECISION_QUERY_CLASS_CAP);
    const junk = shapeDecisionRow(
      { ...baseInput, observedState: { free: 'text', other: {} } },
      ctx,
    );
    expect(junk.observedState).toBeUndefined();
  });

  it('caps alternatives at 8 and keeps ONLY {action, score} pairs', () => {
    const alts = Array.from({ length: 12 }, (_, i) => ({
      action: `a${i}`,
      score: i / 12,
      // An extra field must not survive into the row.
      note: 'free text',
    })) as unknown as Array<{ action: string; score: number }>;
    const row = shapeDecisionRow({ ...baseInput, alternatives: alts }, ctx);
    expect(row.alternatives).toHaveLength(DECISION_ALTERNATIVES_CAP);
    for (const a of row.alternatives!) {
      expect(Object.keys(a).sort()).toEqual(['action', 'score']);
    }
  });

  it('bounds costs to finite non-negative ints and drops the rest', () => {
    const row = shapeDecisionRow(
      {
        ...baseInput,
        costs: {
          latencyMs: 123.7,
          promptTokens: -5,
          completionTokens: Number.NaN,
          toolCalls: undefined,
        },
      },
      ctx,
    );
    expect(row.costs).toEqual({ latencyMs: 124 });
  });

  it('drops a non-finite actionScore and never stamps propensity', () => {
    const row = shapeDecisionRow({ ...baseInput, actionScore: Number.NaN }, ctx);
    expect(row.actionScore).toBeUndefined();
    expect(Object.keys(row)).not.toContain('propensity');
  });
});

describe('MemoryDecisionService.record', () => {
  beforeEach(() => {
    process.env.OUTCOME_DECISION_CAPTURE = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_DECISION_CAPTURE;
  });

  it('is a no-op returning undefined with the flag off', async () => {
    delete process.env.OUTCOME_DECISION_CAPTURE;
    const captured: CapturedQuery[] = [];
    const svc = new MemoryDecisionService(makeSurreal(captured));
    expect(svc.record('co_x', baseInput)).toBeUndefined();
    await flush();
    expect(captured).toEqual([]);
    expect(MemoryDecisionService.enabled()).toBe(false);
  });

  it('INSERT IGNOREs one row with the explicit deterministic record id', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new MemoryDecisionService(makeSurreal(captured));
    const id = svc.record('co_x', { ...baseInput, requestId: 'req-1', actionScore: 0.4 });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toBe('INSERT IGNORE INTO memory_decision $row');
    const row = captured[0]!.params.row as Record<string, unknown>;
    expect(String(row.id)).toBe(`memory_decision:${id}`);
    expect(row.decisionId).toBe(id);
    expect(row.companyId).toBe('co_x');
    expect(row.requestId).toBe('req-1');
    expect(row.actionScore).toBe(0.4);
  });

  it('replays the SAME id for a fresh context with the same correlation id; kind-seq advances within one context', () => {
    const svc = new MemoryDecisionService(makeSurreal([]));
    // Fresh context objects, same correlation id — an upstream replay.
    const a = runWithRequestContext({ correlationId: 'corr-dec' }, () =>
      svc.record('co_x', baseInput),
    );
    const b = runWithRequestContext({ correlationId: 'corr-dec' }, () =>
      svc.record('co_x', baseInput),
    );
    expect(a).toBe(b);
    // Same context: a second same-kind decision gets the NEXT seq.
    const [c, d] = runWithRequestContext({ correlationId: 'corr-dec-2' }, () => [
      svc.record('co_x', baseInput),
      svc.record('co_x', baseInput),
    ]);
    expect(c).not.toBe(d);
  });

  it('a write failure warns and never throws into the caller', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('boom');
      },
    } as unknown as SurrealService;
    const svc = new MemoryDecisionService(surreal);
    expect(() => svc.record('co_x', baseInput)).not.toThrow();
    await flush();
  });
});
