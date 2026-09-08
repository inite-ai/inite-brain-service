/**
 * Wire-contract drift guard for POST /v1/search.
 *
 * Fully-populated samples are typed against the REQUEST DTO and the
 * SERVICE result types (compile-time parity), then parsed against the
 * zod wire contracts (runtime parity), then pinned key-for-key.
 */
import {
  SearchFactSchema,
  SearchHitSchema,
  SearchRequestSchema,
  SearchResponseSchema,
} from '../src/contracts/search/search.schema';
import type { SearchDto } from '../src/search/dto/search.dto';
import type { SearchHit } from '../src/search/search.types';
import type { ScoreBreakdown } from '../src/search/internals/types';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

/** See test/contracts-ingest.unit-spec.ts — explain-mode payloads are open objects. */
const debugPayload = <T>(): T => ({}) as T;

const fullSearchRequest: Required<SearchDto> = {
  query: 'maintenance issues',
  limit: 5,
  entityTypes: ['person'],
  predicates: ['complained_about'],
  entityIds: ['knowledge_entity:cuid_abc'],
  asOf: '2026-09-01T00:00:00.000Z',
  userId: 'user_42',
  minConfidence: 0.2,
  includeContested: true,
  includeRetracted: false,
  includeStale: false,
  searchMode: 'hybrid',
  confidenceFloor: 0.5,
  requireProvenance: true,
  tokenBudget: 2_000,
  outputShape: 'full',
  queryLang: 'en',
  disableLangFilter: false,
};

const fullFact: Required<SearchHit['facts'][number]> = {
  factId: 'knowledge_fact:abc',
  predicate: 'complained_about',
  object: 'late maintenance',
  confidence: 0.85,
  validFrom: '2026-09-01T10:00:00.000Z',
  validUntil: '2026-10-01T00:00:00.000Z',
  status: 'active',
  sourceKey: 'rent:tenant_bot',
  mentionedAt: '2026-09-01T09:59:00.000Z',
  scene: 'a maintenance complaint call',
  highlight: 'late <em>maintenance</em>',
  score: 0.71,
  breakdown: debugPayload<ScoreBreakdown>(),
};

const fullSearchHit: Required<SearchHit> = {
  entityId: 'knowledge_entity:cuid_abc',
  entityType: 'person',
  canonicalName: 'Customer 42',
  externalRefs: { rent: 'cust_42' },
  facts: [fullFact],
  score: 0.71,
};

describe('search wire contracts', () => {
  it('SearchRequestSchema parses a fully-populated DTO', () => {
    expect(() => SearchRequestSchema.parse(fullSearchRequest)).not.toThrow();
  });

  it('SearchResponseSchema parses a fully-populated service result', () => {
    expect(() => SearchResponseSchema.parse({ results: [fullSearchHit] })).not.toThrow();
  });

  it('pins every request/response key on both sides', () => {
    expectKeys(SearchRequestSchema.shape, fullSearchRequest);
    expectKeys(SearchHitSchema.shape, fullSearchHit);
    expectKeys(SearchFactSchema.shape, fullFact);
    expect(Object.keys(SearchResponseSchema.shape)).toEqual(['results']);
  });

  it('rejects an unknown request key (the pipe forbids non-whitelisted)', () => {
    expect(() => SearchRequestSchema.parse({ ...fullSearchRequest, nope: 1 })).toThrow();
  });

  it('enforces the DTO bounds the pipe enforces', () => {
    expect(() => SearchRequestSchema.parse({ query: 'x', limit: 101 })).toThrow();
    expect(() => SearchRequestSchema.parse({ query: 'x', confidenceFloor: 1.5 })).toThrow();
    expect(() => SearchRequestSchema.parse({ query: 'x', searchMode: 'magic' })).toThrow();
  });
});
