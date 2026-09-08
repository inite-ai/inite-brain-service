/**
 * Wire-contract drift guard for the entity read surface — autocomplete,
 * profile, timeline and connections.
 *
 * Fully-populated samples are typed against the SERVICE result
 * interfaces (compile-time parity), then parsed against the zod wire
 * contracts (runtime parity), then pinned key-for-key.
 */
import {
  ConnectionEdgeSchema,
  ConnectionNeighbourSchema,
  EntityAutocompleteResponseSchema,
  EntityAutocompleteSuggestionSchema,
  EntityConnectionsResponseSchema,
  EntityProfileFactSchema,
  EntityProfileResponseSchema,
  EntityTimelineResponseSchema,
  TimelineRecordedEventSchema,
  TimelineRetractedEventSchema,
} from '../src/contracts/entities/entities.schema';
import type {
  AutocompleteSuggestion,
  ConnectionEdge,
  ConnectionNeighbour,
  EntityProfile,
  TimelineRecordedEvent,
  TimelineRetractedEvent,
} from '../src/entities/entities.service';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

const fullSuggestion: Required<AutocompleteSuggestion> = {
  entityId: 'knowledge_entity:cuid_abc',
  canonicalName: 'Customer 42',
  type: 'person',
  score: 3.4,
};

const fullProfileFact: Required<EntityProfile['facts'][number]> = {
  factId: 'knowledge_fact:abc',
  predicate: 'complained_about',
  object: 'late maintenance',
  confidence: 0.85,
  validFrom: '2026-09-01T10:00:00.000Z',
  validUntil: '2026-10-01T00:00:00.000Z',
  status: 'active',
};

const fullProfile: Required<EntityProfile> = {
  entityId: 'knowledge_entity:cuid_abc',
  type: 'person',
  canonicalName: 'Customer 42',
  externalRefs: { rent: 'cust_42' },
  mergedAt: '2026-08-01T00:00:00.000Z',
  mergedInto: 'knowledge_entity:cuid_survivor',
  facts: [fullProfileFact],
};

const fullRecorded: Required<TimelineRecordedEvent> = {
  type: 'fact.recorded',
  at: '2026-09-01T10:00:00.000Z',
  factId: 'knowledge_fact:abc',
  predicate: 'complained_about',
  object: 'late maintenance',
  source: { vertical: 'rent', recorder: 'tenant_bot' },
  confidence: 0.85,
};

const fullRetracted: Required<TimelineRetractedEvent> = {
  type: 'fact.retracted',
  at: '2026-09-02T10:00:00.000Z',
  factId: 'knowledge_fact:abc',
  retractedBy: { source: 'human', userId: 'ops_1' },
  reason: 'entered in error',
  supersededBy: 'knowledge_fact:newer',
};

const fullNeighbour: Required<ConnectionNeighbour> = {
  id: 'knowledge_entity:cuid_other',
  type: 'organisation',
  canonicalName: 'Acme',
};

const fullEdge: Required<ConnectionEdge> = {
  edgeId: 'knowledge_edge:e1',
  from: 'knowledge_entity:cuid_abc',
  to: 'knowledge_entity:cuid_other',
  kind: 'works_at',
  weight: 1,
  source: { vertical: 'rent' },
  createdAt: '2026-09-01T10:00:00.000Z',
  neighbour: fullNeighbour,
  direction: 'outbound',
};

describe('entities wire contracts', () => {
  it('parses fully-populated service results', () => {
    expect(() =>
      EntityAutocompleteResponseSchema.parse({ suggestions: [fullSuggestion] }),
    ).not.toThrow();
    expect(() => EntityProfileResponseSchema.parse(fullProfile)).not.toThrow();
    expect(() =>
      EntityTimelineResponseSchema.parse({
        entityId: fullProfile.entityId,
        events: [fullRecorded, fullRetracted],
      }),
    ).not.toThrow();
    expect(() =>
      EntityConnectionsResponseSchema.parse({
        entityId: fullProfile.entityId,
        edges: [fullEdge],
      }),
    ).not.toThrow();
  });

  it('pins every response key on both sides', () => {
    expectKeys(EntityAutocompleteSuggestionSchema.shape, fullSuggestion);
    expectKeys(EntityProfileResponseSchema.shape, fullProfile);
    expectKeys(EntityProfileFactSchema.shape, fullProfileFact);
    expectKeys(TimelineRecordedEventSchema.shape, fullRecorded);
    expectKeys(TimelineRetractedEventSchema.shape, fullRetracted);
    expectKeys(ConnectionEdgeSchema.shape, fullEdge);
    expectKeys(ConnectionNeighbourSchema.shape, fullNeighbour);
    expect(Object.keys(EntityAutocompleteResponseSchema.shape)).toEqual(['suggestions']);
    expect(Object.keys(EntityTimelineResponseSchema.shape).sort()).toEqual(['entityId', 'events']);
    expect(Object.keys(EntityConnectionsResponseSchema.shape).sort()).toEqual([
      'edges',
      'entityId',
    ]);
  });

  it('keeps the timeline event union discriminated by `type`', () => {
    expect(() =>
      EntityTimelineResponseSchema.parse({
        entityId: fullProfile.entityId,
        events: [{ ...fullRecorded, type: 'fact.exploded' }],
      }),
    ).toThrow();
  });
});
