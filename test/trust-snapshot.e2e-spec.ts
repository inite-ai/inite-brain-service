/**
 * e2e for the source-reputation track, Phase 1 (migration 0044):
 *
 *   1. Every created fact carries `trustSnapshot` — what the resolver
 *      believed about the source AT WRITE TIME ({sourceKey, domain,
 *      declaredTrust, learnedTrust, calculatedAt}), frozen on the row so a
 *      later nightly refit can never silently rewrite the history.
 *   2. A conflict winner carries `conflictTrace` — the scoreBreakdown /
 *      dominantDimension / slotDelta the fn computed, which until 0044 was
 *      returned once (explain:true) and thrown away.
 *   3. `source.evidence[]` round-trips verbatim through the FLEXIBLE
 *      source object; malformed evidence is a 400 at the API boundary.
 */
import { SurrealService } from '../src/db/surreal.service';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('trust snapshot + conflict trace + evidence (Phase 1)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const factRow = async (factId: string) => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT * FROM type::record('knowledge_fact', $rid)`,
        { rid: factId.split(':')[1] },
      );
      return (rows as any[])?.[0];
    });
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_trust_snapshot_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('stamps trustSnapshot on an INSERTED fact', async () => {
    const res = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'trust_snap_customer' },
      predicate: 'status',
      object: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      // billing.* eventId → declared trust 0.95 in the static tier table.
      source: { vertical: 'rent', eventId: 'billing.subscription_started' },
      confidence: 0.9,
    });
    expect(res.body.outcome).toBe('INSERTED');

    const row = await factRow(res.body.factId);
    expect(row.trustSnapshot).toBeDefined();
    // fn::source_key_of: `${vertical}:${recorder ?? '_'}`.
    expect(row.trustSnapshot.sourceKey).toBe('rent:_');
    // Phase 1: domain = the predicate (generic string — Phase 2 scopes
    // reputation by it; a topic layer can reuse the field later).
    expect(row.trustSnapshot.domain).toBe('status');
    expect(row.trustSnapshot.declaredTrust).toBeCloseTo(0.95);
    // No refit has run for this tenant → learned rate is the 0.5 neutral.
    expect(row.trustSnapshot.learnedTrust).toBeCloseTo(0.5);
    expect(row.trustSnapshot.calculatedAt).toBeDefined();
  });

  it('persists conflictTrace on a supersede winner, matching the explain payload', async () => {
    const entityRef = { vertical: 'rent', id: 'trust_trace_customer' };
    const first = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef,
      predicate: 'status',
      object: 'trial',
      validFrom: '2026-01-01T00:00:00Z',
      source: { vertical: 'rent', eventId: 'auth.signup' },
      confidence: 0.8,
    });
    expect(first.body.outcome).toBe('INSERTED');

    const second = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef,
      predicate: 'status',
      object: 'premium',
      validFrom: '2026-03-01T00:00:00Z',
      source: { vertical: 'rent', eventId: 'billing.tier_upgraded' },
      confidence: 0.9,
      explain: true,
    });
    expect(second.body.outcome).toBe('SUPERSEDED');
    const explanation = second.body.conflictExplanation;
    expect(explanation).toBeDefined();

    const row = await factRow(second.body.factId);
    expect(row.conflictTrace).toBeDefined();
    // The stored trace is the same decision the explain path narrated.
    expect(row.conflictTrace.scoreBreakdown).toEqual(
      explanation.scoreBreakdown,
    );
    expect(row.conflictTrace.dominantDimension).toBe(
      explanation.dominantDimension,
    );
    expect(row.conflictTrace.slotDelta).toEqual(explanation.slotDelta);
    expect(String(row.conflictTrace.bestOpponentId)).toBe(first.body.factId);
    expect(row.conflictTrace.decidedAt).toBeDefined();

    // The loser keeps NO conflictTrace — the trace belongs to the decision
    // that created the new fact.
    const loser = await factRow(first.body.factId);
    expect(loser.conflictTrace).toBeUndefined();
    // But both rows carry their own write-time trustSnapshot.
    expect(loser.trustSnapshot).toBeDefined();
  });

  it('round-trips source.evidence[] and rejects malformed evidence', async () => {
    const evidence = [
      { kind: 'url', ref: 'https://docs.example.com/policy#42' },
      { kind: 'commit', ref: 'deadbeef', note: 'where the rule landed' },
    ];
    const ok = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'trust_evidence_customer' },
      predicate: 'preference',
      object: 'prefers email contact',
      validFrom: '2026-01-01T00:00:00Z',
      source: { vertical: 'rent', recorder: 'ops_bot', evidence },
      confidence: 0.9,
    });
    expect(ok.status).toBe(201);
    const row = await factRow(ok.body.factId);
    expect(row.source.evidence).toEqual(evidence);
    expect(row.trustSnapshot.sourceKey).toBe('rent:ops_bot');

    const bad = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'trust_evidence_customer' },
      predicate: 'preference',
      object: 'prefers sms contact',
      validFrom: '2026-01-01T00:00:00Z',
      source: {
        vertical: 'rent',
        evidence: [{ kind: 'rumor', ref: 'heard it somewhere' }],
      },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/kind must be one of/);
  });
});
