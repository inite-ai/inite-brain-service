/**
 * Wire-contract drift guard for POST /v1/search/multi-hop.
 *
 * Fully-populated samples are typed against the REQUEST DTO and the
 * SERVICE result types (compile-time parity), then parsed against the
 * zod wire contracts (runtime parity), then pinned key-for-key.
 */
import {
  HopOutcomeSchema,
  HopPlanSchema,
  MultiHopRequestSchema,
  MultiHopResponseSchema,
} from '../src/contracts/search/multi-hop.schema';
import type { MultiHopDto } from '../src/multi-hop/dto/multi-hop.dto';
import type { HopOutcome, MultiHopResult } from '../src/multi-hop/multi-hop.types';
import type { HopPlan } from '../src/multi-hop/multi-hop-planner.service';
import type { SearchHit } from '../src/search/search.types';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

const hit: SearchHit = {
  entityId: 'knowledge_entity:cuid_abc',
  entityType: 'person',
  canonicalName: 'Customer 42',
  externalRefs: {},
  facts: [],
  score: 0.7,
};

const fullHopPlan: Required<HopPlan> = {
  subQuery: 'tenants who complained in April',
  predicates: ['complained_about'],
  combination: 'seed',
  asOf: '2026-04-30T00:00:00.000Z',
  rationale: 'anchor the chain on April complaints',
};

const fullHopOutcome: Required<HopOutcome> = {
  hop: fullHopPlan,
  hopEntityIds: ['knowledge_entity:cuid_abc'],
  runningEntityIds: ['knowledge_entity:cuid_abc'],
  hits: [hit],
  supportingFactIds: ['knowledge_fact:abc'],
};

const fullRequest: Required<MultiHopDto> = {
  query: 'tenants who complained in April AND upgraded after',
  limit: 5,
  entityTypes: ['person'],
  predicates: ['complained_about'],
  entityIds: [],
  asOf: '2026-09-01T00:00:00.000Z',
  userId: 'user_42',
  minConfidence: 0.2,
  includeContested: false,
  includeRetracted: false,
  includeStale: false,
  searchMode: 'hybrid',
  confidenceFloor: 0.5,
  requireProvenance: false,
  tokenBudget: 2_000,
  outputShape: 'full',
  queryLang: 'en',
  disableLangFilter: false,
  maxHops: 3,
  synthesize: true,
  synthesisGuardrails: 'lenient',
  synthesisModel: 'gpt-4o-mini',
};

const fullResponse: Required<MultiHopResult> = {
  isMultiHop: true,
  hops: [fullHopOutcome],
  finalEntityIds: ['knowledge_entity:cuid_abc'],
  finalHits: [hit],
  supportingFactIds: ['knowledge_fact:abc'],
  synthesis: {
    answer: 'Customer 42.',
    reason: 'verifier_partial',
    citations: [
      {
        factId: 'knowledge_fact:abc',
        entityId: 'knowledge_entity:cuid_abc',
        canonicalName: 'Customer 42',
        predicate: 'complained_about',
        object: 'late maintenance',
      },
    ],
    tokenUsage: { promptTokens: 900, completionTokens: 60 },
  },
};

describe('multi-hop wire contracts', () => {
  it('MultiHopRequestSchema parses a fully-populated DTO', () => {
    expect(() => MultiHopRequestSchema.parse(fullRequest)).not.toThrow();
  });

  it('MultiHopResponseSchema parses a fully-populated service result', () => {
    expect(() => MultiHopResponseSchema.parse(fullResponse)).not.toThrow();
  });

  it('a chain run without synthesize omits the synthesis arm', () => {
    const plain: MultiHopResult = {
      isMultiHop: false,
      hops: [],
      finalEntityIds: [],
      finalHits: [],
      supportingFactIds: [],
    };
    expect(() => MultiHopResponseSchema.parse(plain)).not.toThrow();
  });

  it('pins every request/response key on both sides', () => {
    expectKeys(MultiHopRequestSchema.shape, fullRequest);
    expectKeys(MultiHopResponseSchema.shape, fullResponse);
    expectKeys(HopPlanSchema.shape, fullHopPlan);
    expectKeys(HopOutcomeSchema.shape, fullHopOutcome);
  });

  it('inherits the search request fence and enforces the hop budget', () => {
    expect(() => MultiHopRequestSchema.parse({ ...fullRequest, nope: 1 })).toThrow();
    expect(() => MultiHopRequestSchema.parse({ query: 'x', maxHops: 6 })).toThrow();
  });
});
