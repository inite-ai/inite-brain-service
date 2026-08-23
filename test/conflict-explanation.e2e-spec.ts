/**
 * Phase 2 e2e — TruthfulRAG-style conflict explanation surface on
 * POST /v1/ingest/fact { explain: true }.
 *
 * Two competing 'tier' facts on the same entity, different confidence
 * and different recency → the resolver fires SUPERSEDED. The response
 * must:
 *   - keep the existing outcome + supersededFactIds shape (back-compat)
 *   - carry `conflictExplanation` only when explain=true
 *   - name the dominant scoring axis
 *   - surface a deterministic single-sentence narrative
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('Phase 2 — conflict explanation', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingestTier = async (object: string, when: string, confidence: number, explain = false) =>
    (
      await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'explain_tenant' },
          predicate: 'tier',
          object,
          validFrom: when,
          source: { vertical: 'rent', eventId: 'billing.tier_change' },
          confidence,
          explain,
        })
    ).body;

  it('does NOT include conflictExplanation by default (back-compat)', async () => {
    const first = await ingestTier('standard', '2026-01-01', 0.7);
    expect(first.outcome).toBe('INSERTED');
    expect(first.conflictExplanation).toBeUndefined();
  });

  it('returns SUPERSEDED with a structured conflictExplanation when explain=true', async () => {
    const upgrade = await ingestTier('gold', '2026-04-01', 0.95, true);
    expect(upgrade.outcome).toBe('SUPERSEDED');
    expect(upgrade.supersededFactIds?.length ?? 0).toBeGreaterThan(0);

    expect(upgrade.conflictExplanation).toBeDefined();
    const ce = upgrade.conflictExplanation;

    expect(ce.outcome).toBe('SUPERSEDED');
    expect(ce.winnerFactId).toBe(upgrade.factId);
    expect(ce.bestOpponentFactId).toBeTruthy();
    expect(['confidence', 'source_trust', 'recency', 'authority']).toContain(ce.dominantDimension);

    expect(ce.scoreBreakdown.winner.total).toBeGreaterThan(ce.scoreBreakdown.loser.total);
    expect(ce.scoreBreakdown.margin).toBeGreaterThan(0);

    expect(typeof ce.narrativeBullet).toBe('string');
    expect(ce.narrativeBullet.length).toBeGreaterThan(0);
    expect(ce.narrativeBullet).toContain('superseded');
  });

  it('flags the `object` slot as differing between winner and best opponent', async () => {
    const next = await ingestTier('platinum', '2026-05-01', 0.95, true);
    expect(next.outcome).toBe('SUPERSEDED');
    const slot = next.conflictExplanation?.slotDelta;
    expect(slot).toBeDefined();
    expect(slot.object).toBe(true);
    // Same predicate by construction — must be reported equal.
    expect(slot.predicate).toBe(false);
  });
});
