/**
 * Wire-contract drift guard for GET /v1/beliefs/:id and
 * GET /v1/beliefs (the contracts-facts idiom).
 *
 * Fully-populated samples are typed against the SERVICE result
 * interfaces (compile-time parity), then parsed against the zod wire
 * contracts (runtime parity), then pinned key-for-key — a field added
 * to one side without the other fails loudly.
 */
import {
  BeliefReadResponseSchema,
  BeliefsListResponseSchema,
} from '../src/contracts/beliefs/beliefs.schema';
import type { BeliefReadResult, BeliefsListResult } from '../src/beliefs/beliefs.service';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

const fullBelief: Required<BeliefReadResult> = {
  beliefId: 'semantic_belief:abc',
  userId: 'user-1',
  subject: 'mika',
  field: 'home.city',
  value: 'porto',
  priorValue: 'lisbon',
  statement: 'mika — home.city: porto (was: lisbon)',
  statementSource: 'template',
  confidence: 0.85,
  revision: 2,
  status: 'active',
  supersededBy: 'semantic_belief:def',
  validFrom: '2026-03-05T10:00:00.000Z',
  validUntil: '2026-03-09T10:00:00.000Z',
  sourceSceneIds: ['memory_episode:sb'],
  conversationIds: ['proj:c3'],
  corroborationCount: 1,
  conversationCount: 1,
  promoterVersion: 'belief-promotion-v1|scene-segmenter-v1',
};

const fullList: Required<BeliefsListResult> = {
  beliefs: [fullBelief],
  found: 1,
};

describe('beliefs wire contracts', () => {
  it('BeliefReadResponseSchema parses a fully-populated service result', () => {
    expect(BeliefReadResponseSchema.safeParse(fullBelief).success).toBe(true);
  });

  it('BeliefReadResponseSchema parses the minimal shape (optionals absent)', () => {
    const { priorValue, supersededBy, validUntil, promoterVersion, ...minimal } = fullBelief;
    void priorValue;
    void supersededBy;
    void validUntil;
    void promoterVersion;
    expect(BeliefReadResponseSchema.safeParse(minimal).success).toBe(true);
  });

  it('BeliefReadResponseSchema covers every service field — both directions', () => {
    expectKeys(BeliefReadResponseSchema.shape, fullBelief);
  });

  it('BeliefsListResponseSchema parses a fully-populated list result', () => {
    expect(BeliefsListResponseSchema.safeParse(fullList).success).toBe(true);
  });

  it('BeliefsListResponseSchema covers every list field — both directions', () => {
    expectKeys(BeliefsListResponseSchema.shape, fullList);
  });
});
