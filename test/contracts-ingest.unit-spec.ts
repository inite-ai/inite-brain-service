/**
 * Wire-contract drift guard for POST /v1/ingest/fact.
 *
 * Fully-populated samples are typed against the REQUEST DTO and the
 * SERVICE result interface (compile-time parity), then parsed against
 * the zod wire contracts (runtime parity), then pinned key-for-key — a
 * field added to one side without the other fails loudly.
 */
import {
  EntityRefSchema,
  FactSourceSchema,
  IngestFactRequestSchema,
  IngestFactResponseSchema,
  SourceEvidenceSchema,
} from '../src/contracts/ingest/ingest.schema';
import type {
  EntityRef,
  FactSource,
  IngestFactDto,
  SourceEvidence,
} from '../src/ingest/dto/ingest-fact.dto';
import type { ConflictExplanation } from '../src/ingest/conflict-explainer';
import type { IngestResult } from '../src/ingest/ingest-result';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

/**
 * The `explain`-mode debug payloads are published as OPEN objects (see
 * the schema docblocks): their internals track resolver/scorer
 * internals and are deliberately not part of the wire contract, so a
 * sample only has to BE an object of the right type.
 */
const debugPayload = <T>(): T => ({}) as T;

const fullEvidence: Required<SourceEvidence> = {
  kind: 'message',
  ref: 'msg_1',
  note: 'tenant chat',
};

const fullEntityRef: Required<EntityRef> = {
  vertical: 'rent',
  id: 'cust_42',
  entityId: 'knowledge_entity:cuid_abc',
};

const fullSource: Required<FactSource> = {
  vertical: 'rent',
  eventId: 'evt_1',
  conversationId: 'conv_1',
  messageId: 'msg_1',
  recorder: 'tenant_bot',
  evidence: [fullEvidence],
  episodeIds: ['episode:e1'],
};

const fullRequest: Required<IngestFactDto> = {
  entityRef: fullEntityRef,
  predicate: 'complained_about',
  object: 'late maintenance',
  validFrom: '2026-09-01T10:00:00.000Z',
  validUntil: '2026-10-01T00:00:00.000Z',
  confidence: 0.9,
  source: fullSource,
  userId: 'user_42',
  metadata: { channel: 'sms' },
  explain: true,
};

const fullResponse: Required<IngestResult> = {
  factId: 'knowledge_fact:abc',
  outcome: 'SUPERSEDED',
  supersededFactIds: ['knowledge_fact:old'],
  competingFactIds: ['knowledge_fact:rival'],
  supersededByFactId: 'knowledge_fact:newer',
  corroboratedFactId: 'knowledge_fact:incumbent',
  reason: 'newer validFrom wins the single_active slot',
  conflictExplanation: debugPayload<ConflictExplanation>(),
};

describe('ingest wire contracts', () => {
  it('IngestFactRequestSchema parses a fully-populated DTO', () => {
    expect(() => IngestFactRequestSchema.parse(fullRequest)).not.toThrow();
  });

  it('IngestFactResponseSchema parses a fully-populated service result', () => {
    expect(() => IngestFactResponseSchema.parse(fullResponse)).not.toThrow();
  });

  it('a REJECTED outcome carries a null factId', () => {
    const rejected: IngestResult = { factId: null, outcome: 'REJECTED', reason: 'lower trust' };
    expect(() => IngestFactResponseSchema.parse(rejected)).not.toThrow();
  });

  it('pins every request/response key on both sides', () => {
    expectKeys(IngestFactRequestSchema.shape, fullRequest);
    expectKeys(IngestFactResponseSchema.shape, fullResponse);
    expectKeys(EntityRefSchema.shape, fullEntityRef);
    expectKeys(FactSourceSchema.shape, fullSource);
    expectKeys(SourceEvidenceSchema.shape, fullEvidence);
  });

  it('rejects an unknown request key (the pipe forbids non-whitelisted)', () => {
    expect(() => IngestFactRequestSchema.parse({ ...fullRequest, nope: 1 })).toThrow();
  });

  it('lets the opaque @IsObject() fields carry keys the pipe never validates', () => {
    // entityRef / source are shape-checked by FactIngestService, not by
    // class-validator — an extra key inside them is NOT a 400.
    expect(() =>
      IngestFactRequestSchema.parse({
        ...fullRequest,
        source: { ...fullSource, futureField: 'x' },
      }),
    ).not.toThrow();
  });
});
