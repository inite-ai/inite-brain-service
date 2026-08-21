/**
 * Wire-contract drift guard for GET /v1/facts/:id and
 * GET /v1/facts/:id/provenance.
 *
 * Fully-populated samples are typed against the SERVICE result
 * interfaces (compile-time parity), then parsed against the zod wire
 * contracts (runtime parity), then pinned key-for-key — a field added
 * to one side without the other fails loudly.
 */
import {
  FactProvenanceEpisodeSchema,
  FactProvenanceResponseSchema,
  FactReadResponseSchema,
} from '../src/contracts/facts/facts.schema';
import type {
  FactProvenanceEpisode,
  FactProvenanceResult,
  FactReadResult,
} from '../src/facts/facts.service';

const fullFact: Required<FactReadResult> = {
  factId: 'knowledge_fact:abc',
  aspect: 'residence',
  statement: 'Lives in Lisbon',
  confidence: 0.85,
  validFrom: '2026-08-01T00:00:00.000Z',
  userId: 'user-1',
  kind: 'persona_attr',
  vertical: 'derived',
  recorder: 'wd-v2',
  conversationId: 'conv-1',
  retracted: false,
  derivedVersion: 'wd-v2',
};

const fullEpisode: Required<FactProvenanceEpisode> = {
  episodeId: 'episode:e1',
  conversationId: 'conv-1',
  speaker: 'user',
  occurredAt: '2026-08-01T12:00:00.000Z',
  text: 'I moved to Lisbon last month.',
};

const fullProvenance: FactProvenanceResult = {
  factId: 'knowledge_fact:abc',
  episodes: [fullEpisode],
};

describe('facts wire contracts', () => {
  it('FactReadResponseSchema parses a fully-populated service result', () => {
    const parsed = FactReadResponseSchema.safeParse(fullFact);
    expect(parsed.success).toBe(true);
  });

  it('FactReadResponseSchema covers every service field — both directions', () => {
    expect(Object.keys(FactReadResponseSchema.shape).sort()).toEqual(
      Object.keys(fullFact).sort(),
    );
  });

  it('FactProvenanceResponseSchema parses a fully-populated result', () => {
    const parsed = FactProvenanceResponseSchema.safeParse(fullProvenance);
    expect(parsed.success).toBe(true);
  });

  it('FactProvenanceEpisodeSchema covers every episode field — both directions', () => {
    expect(Object.keys(FactProvenanceEpisodeSchema.shape).sort()).toEqual(
      Object.keys(fullEpisode).sort(),
    );
  });
});
