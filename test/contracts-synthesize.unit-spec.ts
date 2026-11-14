/**
 * Wire-contract drift guard for POST /v1/synthesize.
 *
 * Fully-populated samples are typed against the REQUEST DTO and the
 * SERVICE result types (compile-time parity), then parsed against the
 * zod wire contracts (runtime parity), then pinned key-for-key.
 */
import {
  CitationSchema,
  EvidenceCitationSchema,
  SynthesizeRequestSchema,
  SynthesizeResponseSchema,
  TokenUsageSchema,
} from '../src/contracts/synthesize/synthesize.schema';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type {
  EvidenceCitation,
  SynthesizeResult,
  TokenUsage,
} from '../src/synthesize/synthesize.types';
import type { Citation } from '../src/synthesize/fact-index';
import type { DecisionLogEntry } from '../src/synthesize/decision-log';
import type { SearchHit } from '../src/search/search.types';
import { ServerModelsNoticeSchema } from '../src/contracts/common/server-models-notice.schema';
import { SERVER_MODELS_NOTICE, type ServerModelsNotice } from '../src/ai/provider-failure';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

/** See test/contracts-ingest.unit-spec.ts — explain-mode payloads are open objects. */
const debugPayload = <T>(): T => ({}) as T;

const hit: SearchHit = {
  entityId: 'knowledge_entity:cuid_abc',
  entityType: 'person',
  canonicalName: 'Customer 42',
  externalRefs: {},
  facts: [],
  score: 0.7,
};

const fullCitation: Required<Citation> = {
  factId: 'knowledge_fact:abc',
  entityId: 'knowledge_entity:cuid_abc',
  canonicalName: 'Customer 42',
  predicate: 'complained_about',
  slot: 'complained_about',
  object: 'late maintenance',
  validFrom: '2026-09-01T00:00:00.000Z',
  sourceKey: 'rent:tenant_bot',
};

const fullUsage: Required<TokenUsage> = { promptTokens: 900, completionTokens: 60 };

const fullEvidenceCitation: Required<EvidenceCitation> = {
  episodeId: 'episode:e1',
  conversationId: 'conv_1',
  occurredAt: '2026-09-01T10:00:00.000Z',
  span: { start: 2, end: 22, exact: 'moved to Lisbon last' },
  fragmentId: 'evidence_fragment:f1',
  assetId: 'evidence_asset:a1',
  capability: 'visual',
  excerpt: 'a photo of the leaking ceiling',
  beliefId: 'semantic_belief:b1',
  sceneId: 'memory_episode:s1',
};

const fullRequest: Required<SynthesizeDto> = {
  query: 'what did customer 42 complain about?',
  limit: 5,
  entityTypes: ['person'],
  predicates: ['complained_about'],
  entityIds: ['knowledge_entity:cuid_abc'],
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
  synthesisModel: 'gpt-4o-mini',
  synthesisGuardrails: 'strict',
  explain: true,
  answerLang: 'en',
};

const fullResponse: Required<SynthesizeResult> = {
  answer: 'Late maintenance.',
  reason: 'verifier_partial',
  citations: [fullCitation],
  results: [hit],
  evidenceCitations: [fullEvidenceCitation],
  decisionLog: [debugPayload<DecisionLogEntry>()],
  tokenUsage: fullUsage,
  cached: false,
  degraded: ['verifier'],
  notice: SERVER_MODELS_NOTICE,
};

describe('synthesize wire contracts', () => {
  it('SynthesizeRequestSchema parses a fully-populated DTO', () => {
    expect(() => SynthesizeRequestSchema.parse(fullRequest)).not.toThrow();
  });

  it('SynthesizeResponseSchema parses a fully-populated service result', () => {
    expect(() => SynthesizeResponseSchema.parse(fullResponse)).not.toThrow();
  });

  it('an abstention carries a null answer plus a reason', () => {
    const abstained: SynthesizeResult = {
      answer: null,
      reason: 'low_coverage',
      citations: [],
      results: [],
    };
    expect(() => SynthesizeResponseSchema.parse(abstained)).not.toThrow();
  });

  it('a provider outage is model_unavailable with degraded + notice, never an abstention (#945)', () => {
    const outage: SynthesizeResult = {
      answer: null,
      reason: 'model_unavailable',
      citations: [],
      results: [],
      degraded: ['generator'],
      notice: SERVER_MODELS_NOTICE,
    };
    expect(() => SynthesizeResponseSchema.parse(outage)).not.toThrow();
    expect(() => SynthesizeResponseSchema.parse({ ...outage, degraded: ['embedder'] })).toThrow();
    expect(() =>
      SynthesizeResponseSchema.parse({ ...outage, notice: { code: 'other', message: 'x' } }),
    ).toThrow();
    const notice: ServerModelsNotice = SERVER_MODELS_NOTICE;
    expectKeys(ServerModelsNoticeSchema.shape, notice as unknown as Record<string, unknown>);
    expect(ServerModelsNoticeSchema.parse(notice)).toEqual(notice);
  });

  it('pins every request/response key on both sides', () => {
    expectKeys(SynthesizeRequestSchema.shape, fullRequest);
    expectKeys(SynthesizeResponseSchema.shape, fullResponse);
    expectKeys(CitationSchema.shape, fullCitation);
    expectKeys(EvidenceCitationSchema.shape, fullEvidenceCitation);
    expectKeys(TokenUsageSchema.shape, fullUsage);
  });

  it('inherits the search request fence (unknown key rejected, bounds enforced)', () => {
    expect(() => SynthesizeRequestSchema.parse({ ...fullRequest, nope: 1 })).toThrow();
    expect(() =>
      SynthesizeRequestSchema.parse({ query: 'x', synthesisGuardrails: 'maybe' }),
    ).toThrow();
  });
});
