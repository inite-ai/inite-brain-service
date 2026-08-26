/**
 * Decision-context telemetry e2e (migration 0119, OUTCOME_DECISION_CAPTURE):
 *   (a) a coverage-abstained /v1/synthesize writes ONE 'abstain' decision
 *       row (static policy, costs.latencyMs int, content-free);
 *   (b) a SERVED request (coverage-proceed floors + mocked OpenAI) writes
 *       a 'proceed' decision; the outcome rows carry its decisionId
 *       (join), and the verdict-stage focus_signal_sample carries it too;
 *   (c) GDPR entity-forget purges the decision rows THROUGH the outcome
 *       join (decisions carry no subject linkage by design);
 *   (d) user-forget leg — same join purge on the user-scoped slice;
 *   (e) capture off ⇒ zero decision rows (byte-identical).
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { MemoryOutcomeService } from '../src/outcomes/memory-outcome.service';
import { MemoryDecisionService } from '../src/outcomes/memory-decision.service';
import { mockSynthesizeOpenAi } from './test-doubles';

interface DecisionRowWire {
  decisionId: string;
  decisionKind: string;
  chosenAction: string;
  policyVersion: string;
  requestId?: string;
  actionScore?: number;
  observedState?: Record<string, unknown>;
  costs?: { latencyMs?: number };
}

describe('memory_decision — decision-context capture, joins and cascade', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_decision_e2e' });
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
    process.env.OUTCOME_DECISION_CAPTURE = '1';
  });

  afterAll(async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    delete process.env.OUTCOME_DECISION_CAPTURE;
    delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
    delete process.env.RETRIEVAL_ABSTENTION_MIN_EVIDENCE;
    delete process.env.RETRIEVAL_ABSTENTION_MIN_SCORE;
    delete process.env.FOVEA_FOCUS_CAPTURE;
    if (f) await f.close();
  });

  const tail = (factId: string) => factId.split(':')[1];

  const decisionRows = async (): Promise<DecisionRowWire[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      // createdAt must appear in the selection — the 3.x parser rejects an
      // ORDER BY over a non-selected idiom.
      const [rows] = await db.query<[DecisionRowWire[]]>(
        `SELECT decisionId, decisionKind, chosenAction, policyVersion, requestId,
                actionScore, observedState, costs, createdAt
           FROM memory_decision ORDER BY createdAt ASC`,
      );
      return (rows as DecisionRowWire[]) ?? [];
    });
  };

  const purgeDecisions = async (): Promise<void> => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      // Full-table delete (no WHERE) — outside the 3.2.4 planner no-op class.
      await db.query(`DELETE memory_decision`);
    });
  };

  const outcomeRows = async (
    factId: string,
  ): Promise<Array<{ event: string; decisionId?: string }>> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ event: string; decisionId?: string }>]>(
        `SELECT event, decisionId FROM memory_outcome
          WHERE subjectId = type::record('knowledge_fact', $tail)`,
        { tail: tail(factId) },
      );
      return (rows as Array<{ event: string; decisionId?: string }>) ?? [];
    });
  };

  /** Writers are fire-and-forget — poll until the condition holds. */
  const waitFor = async <T>(probe: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let last: T = await probe();
    for (let i = 0; i < 40 && !ok(last); i++) {
      await new Promise((r) => setTimeout(r, 100));
      last = await probe();
    }
    return last;
  };

  const ingestFact = async (
    entityId: string,
    object: string,
    opts: { userId?: string } = {},
  ): Promise<{ factId: string }> => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: entityId },
        predicate: 'name',
        object,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        ...(opts.userId ? { userId: opts.userId } : {}),
      });
    expect([200, 201]).toContain(res.status);
    return res.body;
  };

  it('(a) a coverage-abstained synthesize writes ONE static abstain decision', async () => {
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'coverage';
    // Default floors: minEvidence 2 — a single-fact evidence set abstains.
    try {
      await ingestFact('decision_abstain_subj', 'Decision Abstain Subject');
      const res = await f.http
        .post('/v1/synthesize')
        .set(auth())
        .send({ query: 'Decision Abstain Subject', limit: 5 });
      expect(res.status).toBe(201);
      expect(res.body.reason).toBe('low_coverage');

      const rows = await waitFor(
        () => decisionRows(),
        (r) => r.length >= 1,
      );
      expect(rows).toHaveLength(1);
      const d = rows[0]!;
      expect(d.decisionKind).toBe('abstain');
      expect(d.chosenAction).toBe('abstain');
      expect(d.policyVersion).toBe('static');
      expect(d.decisionId).toMatch(/^[0-9a-f]{32}$/);
      // The correlation id of the request is stamped (minted by the
      // middleware when the caller sends none).
      expect(typeof d.requestId).toBe('string');
      expect(Number.isInteger(d.costs?.latencyMs)).toBe(true);
      // Content-free observedState: signal numbers + class only.
      expect(d.observedState).toMatchObject({ candidateCount: 1 });
      expect(Object.keys(d.observedState ?? {}).sort()).toEqual(
        [
          'candidateCount',
          'coverageScore',
          'queryClass',
          'rawConfidence',
          'retrievalGap',
          'topScore',
        ].sort(),
      );
    } finally {
      delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
      await purgeDecisions();
    }
  });

  it('(b) a served request writes a proceed decision; outcomes + focus sample join it', async () => {
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'coverage';
    process.env.RETRIEVAL_ABSTENTION_MIN_EVIDENCE = '1';
    process.env.RETRIEVAL_ABSTENTION_MIN_SCORE = '0';
    process.env.FOVEA_FOCUS_CAPTURE = '1';
    try {
      const { factId } = await ingestFact('decision_serve_subj', 'Decision Serve Subject');
      mockSynthesizeOpenAi(f.app, [
        JSON.stringify({ answer: `Served [${factId}].`, citedFactIds: [factId] }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ]);
      const res = await f.http
        .post('/v1/synthesize')
        .set(auth())
        .send({ query: 'Decision Serve Subject', limit: 5 });
      expect(res.status).toBe(201);
      expect(res.body.answer).toContain('Served');

      const rows = await waitFor(
        () => decisionRows(),
        (r) => r.length >= 1,
      );
      const proceed = rows.find((r) => r.chosenAction === 'proceed');
      expect(proceed).toBeDefined();
      expect(proceed!.decisionKind).toBe('abstain');

      // The outcome rows carry the decisionId join (used + verified).
      const outcomes = await waitFor(
        () => outcomeRows(factId),
        (r) => r.some((x) => x.event === 'used_in_answer'),
      );
      const used = outcomes.find((x) => x.event === 'used_in_answer');
      expect(used?.decisionId).toBe(proceed!.decisionId);
      const verified = outcomes.find((x) => x.event === 'verifier_supported');
      expect(verified?.decisionId).toBe(proceed!.decisionId);

      // The verdict-stage focus sample carries the same join key.
      const surreal = f.app.get(SurrealService);
      const samples = await waitFor(
        () =>
          surreal.withCompany(f.companyId, async (db) => {
            const [r] = await db.query<[Array<{ stage?: string; decisionId?: string }>]>(
              `SELECT stage, decisionId FROM focus_signal_sample WHERE decisionId = $d`,
              { d: proceed!.decisionId },
            );
            return (r as Array<{ stage?: string; decisionId?: string }>) ?? [];
          }),
        (r) => r.length >= 1,
      );
      expect(samples.length).toBeGreaterThanOrEqual(1);
      expect(samples[0]!.stage).toBe('verdict');
    } finally {
      delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
      delete process.env.RETRIEVAL_ABSTENTION_MIN_EVIDENCE;
      delete process.env.RETRIEVAL_ABSTENTION_MIN_SCORE;
      delete process.env.FOVEA_FOCUS_CAPTURE;
    }
  });

  it('(c) entity-forget purges decision rows through the outcome join', async () => {
    // Leg (b) left: a proceed decision + outcome rows joining it on the
    // decision_serve_subj entity. Forget the entity → outcomes AND the
    // joined decision rows die (over-deletion accepted — content-free).
    const before = await decisionRows();
    expect(before.length).toBeGreaterThanOrEqual(1);
    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_entity WHERE canonicalName = $n LIMIT 1`,
        { n: 'decision_serve_subj' },
      );
      return String((rows as Array<{ id: unknown }>)?.[0]?.id);
    });
    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-decision-1' });
    expect([200, 201]).toContain(forget.status);
    // The proceed decision (joined via the erased subject's outcomes) is gone.
    const after = await decisionRows();
    expect(after.find((r) => r.chosenAction === 'proceed')).toBeUndefined();
    await purgeDecisions();
  });

  it('(d) user-forget purges the user slice: outcomes + joined decisions', async () => {
    const { factId } = await ingestFact('decision_user_subj', 'Decision User Subject', {
      userId: 'user_decision_1',
    });
    // Drive the seams the way the emit path does: one decision row, then
    // outcome events stamped with its id (legacy write path — decisionId
    // is one more optional column there).
    const decisionId = f.app.get(MemoryDecisionService).record(f.companyId, {
      decisionKind: 'abstain',
      policyVersion: 'static',
      chosenAction: 'proceed',
    })!;
    expect(decisionId).toMatch(/^[0-9a-f]{32}$/);
    f.app.get(MemoryOutcomeService).recordOutcomes({
      companyId: f.companyId,
      events: [{ subjectKind: 'fact', subjectId: factId, event: 'used_in_answer', decisionId }],
    });
    await waitFor(
      () => outcomeRows(factId),
      (r) => r.length >= 1,
    );
    await waitFor(
      () => decisionRows(),
      (r) => r.some((x) => x.decisionId === decisionId),
    );

    const userForget = await f.http.post('/v1/users/user_decision_1/forget').set(auth()).send({});
    expect([200, 201]).toContain(userForget.status);
    expect(await outcomeRows(factId)).toHaveLength(0);
    expect((await decisionRows()).find((r) => r.decisionId === decisionId)).toBeUndefined();
  });

  it('(e) capture off ⇒ zero decision rows (byte-identical)', async () => {
    delete process.env.OUTCOME_DECISION_CAPTURE;
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'coverage';
    try {
      await purgeDecisions();
      await ingestFact('decision_off_subj', 'Decision Off Subject');
      const res = await f.http
        .post('/v1/synthesize')
        .set(auth())
        .send({ query: 'Decision Off Subject', limit: 5 });
      expect(res.status).toBe(201);
      // Fire-and-forget writers: give any (buggy) write time to land.
      await new Promise((r) => setTimeout(r, 500));
      expect(await decisionRows()).toHaveLength(0);
    } finally {
      process.env.OUTCOME_DECISION_CAPTURE = '1';
      delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
    }
  });
});
