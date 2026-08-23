import {
  buildConflictExplanation,
  type ResolverConflictPayload,
} from '../src/ingest/conflict-explainer';

function makePayload(overrides: Partial<ResolverConflictPayload> = {}): ResolverConflictPayload {
  return {
    outcome: 'SUPERSEDED',
    factId: 'fact:new',
    bestOpponentId: 'fact:old',
    supersededFactIds: ['fact:old'],
    scoreBreakdown: {
      winner: {
        total: 0.85,
        confidence: 0.27,
        sourceTrust: 0.4,
        recency: 0.18,
        authority: 0,
      },
      loser: {
        total: 0.55,
        confidence: 0.18,
        sourceTrust: 0.2,
        recency: 0.17,
        authority: 0,
      },
      margin: 0.3,
    },
    dominantDimension: 'source_trust',
    slotDelta: {
      predicate: false,
      object: true,
      validFrom: false,
      source: true,
    },
    ...overrides,
  };
}

describe('buildConflictExplanation', () => {
  it('echoes outcome + winner + bestOpponent', () => {
    const e = buildConflictExplanation(makePayload());
    expect(e.outcome).toBe('SUPERSEDED');
    expect(e.winnerFactId).toBe('fact:new');
    expect(e.bestOpponentFactId).toBe('fact:old');
  });

  it('separates best opponent from other losers', () => {
    const e = buildConflictExplanation(
      makePayload({
        supersededFactIds: ['fact:old', 'fact:older', 'fact:oldest'],
      }),
    );
    expect(e.bestOpponentFactId).toBe('fact:old');
    expect(e.otherLoserFactIds).toEqual(['fact:older', 'fact:oldest']);
  });

  it('handles COMPETING outcome (competingFactIds → otherLosers)', () => {
    const e = buildConflictExplanation(
      makePayload({
        outcome: 'COMPETING',
        competingFactIds: ['fact:old', 'fact:older'],
      }),
    );
    expect(e.outcome).toBe('COMPETING');
    expect(e.otherLoserFactIds).toEqual(['fact:older']);
  });

  it('renders a deterministic narrative naming the dominant dim', () => {
    const e = buildConflictExplanation(makePayload());
    expect(e.narrativeBullet).toContain('superseded');
    expect(e.narrativeBullet).toContain('source trust');
    expect(e.narrativeBullet).toMatch(/\+0\.300/);
  });

  it('lists object + source slot deltas in the narrative', () => {
    const e = buildConflictExplanation(makePayload());
    expect(e.narrativeBullet).toContain('object');
    expect(e.narrativeBullet).toContain('source');
  });

  it('omits "differs by" when every slot is equal', () => {
    const e = buildConflictExplanation(
      makePayload({
        slotDelta: {
          predicate: false,
          object: false,
          validFrom: false,
          source: false,
        },
      }),
    );
    expect(e.narrativeBullet).not.toContain('differs by');
  });

  it('uses "competes with" verb for COMPETING outcome', () => {
    const e = buildConflictExplanation(
      makePayload({
        outcome: 'COMPETING',
        competingFactIds: ['fact:old'],
      }),
    );
    expect(e.narrativeBullet).toMatch(/competes with/);
  });

  it('honours dominantDimension=recency in the rendered phrase', () => {
    const e = buildConflictExplanation(makePayload({ dominantDimension: 'recency' }));
    expect(e.narrativeBullet).toContain('recency');
  });

  it('echoes the full scoreBreakdown', () => {
    const payload = makePayload();
    const e = buildConflictExplanation(payload);
    expect(e.scoreBreakdown).toEqual(payload.scoreBreakdown);
  });
});
