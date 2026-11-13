/**
 * The response shapes of the routes this client calls, as brain publishes
 * them. The source of truth is the server's zod contracts under
 * `src/contracts/` (also rendered as docs/openapi.json); this package ships
 * without them, so each type here is a copy, and
 * `test/brain-sdk.unit-spec.ts` in the brain repo fails typecheck when a
 * copy and its contract differ in either direction.
 */

/** One fact of a search hit — `SearchFactSchema`. */
export interface SearchFact {
  factId: string;
  /** As written: the coinage the fact was stored under. */
  predicate: string;
  /** The canon it was aliased onto; identity is `predicateAlias ?? predicate`. */
  predicateAlias?: string | undefined;
  object: string;
  /** The calendar day (YYYY-MM-DD) the value refers to, resolved at write time. */
  date?: string | undefined;
  confidence: number;
  validFrom: string;
  validUntil?: string | undefined;
  /** When a temporary state is expected to be over: an expectation, not an end. */
  expectedUntil?: string | undefined;
  status: string;
  /** Write-time source key: chase a citation to its claimer. */
  sourceKey?: string | undefined;
  /** Event time of the fact's first grounding turn. */
  mentionedAt?: string | undefined;
  /** One clause of encoding context: the situation the fact was learned in. */
  scene?: string | undefined;
  /** BM25 snippet with `<em>` around matched terms. */
  highlight?: string | undefined;
  score: number;
  breakdown?: Record<string, unknown> | undefined;
}

/** One 1-hop graph relation of a hit — `SearchRelationSchema`. */
export interface SearchRelation {
  kind: string;
  peer: string;
  peerType: string;
  peerId?: string | undefined;
  /** The knowledge_edge record behind the relation: what a citation of it names. */
  edgeId?: string | undefined;
  /** 'out': the hit's entity is the subject; 'in': its object. */
  direction?: 'out' | 'in' | undefined;
  validFrom?: string | undefined;
  validUntil?: string | undefined;
}

/** One entity a search matched, with its facts — `SearchHitSchema`. */
export interface SearchHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  relations?: SearchRelation[] | undefined;
  facts: SearchFact[];
  score: number;
}

/** One answer a linked source gave at query time — `LinkedHitSchema`. */
export interface LinkedHit {
  externalId: string;
  title: string;
  originUri?: string | undefined;
  snippet?: string | undefined;
  score?: number | undefined;
  modifiedAt?: string | undefined;
}

/** `LinkedSourceResultSchema`. */
export interface LinkedSourceResult {
  connectionId: string;
  connector: string;
  /** `tool_observation:<id>`: pass it to ingest to keep the provenance chain. */
  observationRef: string;
  hits: LinkedHit[];
}

/** `POST /v1/search` — `SearchResponseSchema`. */
export interface SearchResponse {
  results: SearchHit[];
  /** Sources that were asked rather than remembered; never mixed into `results`. */
  linked?: LinkedSourceResult[] | undefined;
  /** `vector_leg`: `results` is a lexical-only ranking; retry later for the full one. */
  degraded?: 'vector_leg'[] | undefined;
  /** The provider refused the embedder for billing, key or quota reasons: retrying will not help. */
  notice?: ServerModelsNotice | undefined;
}

/**
 * `ServerModelsNoticeSchema`: the server's model provider refused part of
 * the work; use your own provider key (BYOK) or harness mode.
 */
export interface ServerModelsNotice {
  code: 'server_models_unavailable';
  message: string;
}

/** `POST /v1/ingest/mention` — `IngestMentionResponseSchema`. */
export interface IngestMentionResponse {
  /** true when nothing was extracted; `reason` says why. */
  skipped: boolean;
  reason?: string | undefined;
  /** Remembered, with extraction queued: the id lists fill in once the conversation is read. */
  pending?: boolean | undefined;
  extractedEntityIds: string[];
  extractedFactIds: string[];
  extractedEdgeIds?: string[] | undefined;
  /** The episode turn this mention was captured as. */
  episodeId?: string | undefined;
}

/** `POST /v1/ingest/fact` — `IngestFactResponseSchema`. */
export interface IngestFactResponse {
  /** null when the resolver rejected the claim. */
  factId: string | null;
  outcome:
    'INSERTED' | 'INSERTED_HISTORICAL' | 'CORROBORATED' | 'SUPERSEDED' | 'COMPETING' | 'REJECTED';
  supersededFactIds?: string[] | undefined;
  competingFactIds?: string[] | undefined;
  supersededByFactId?: string | undefined;
  corroboratedFactId?: string | undefined;
  reason?: string | undefined;
  conflictExplanation?: Record<string, unknown> | undefined;
}

/** Why brain gave no answer (`answer: null`) — `SynthesisReasonSchema`. */
export type SynthesisReason =
  | 'no_results'
  | 'no_grounded_evidence'
  | 'low_coverage'
  | 'evidence_capability_unmet'
  | 'ungrounded_evidence'
  | 'verifier_failed'
  | 'verifier_partial'
  | 'generator_error'
  | 'harness_mode'
  | 'model_budget'
  | 'verifier_error'
  /** The server's model provider refused the generator or verifier; see `degraded`, `notice`. */
  | 'model_unavailable';

/** A claim's reference to the fact it rests on — `CitationSchema`. */
export interface Citation {
  factId: string;
  entityId: string;
  canonicalName: string;
  predicate: string;
  /** `predicateAlias ?? predicate`: the identity every consumer keys on. */
  slot: string;
  object: string;
  sourceKey?: string | undefined;
  validFrom?: string | undefined;
}

/** Non-fact evidence: exactly one of the id fields is present — `EvidenceCitationSchema`. */
export interface EvidenceCitation {
  episodeId?: string | undefined;
  conversationId?: string | undefined;
  occurredAt?: string | undefined;
  /** A verified span over the stored turn text, in code points; `end` exclusive. */
  span?: { start: number; end: number; exact: string } | undefined;
  fragmentId?: string | undefined;
  assetId?: string | undefined;
  capability?: 'text' | 'visual' | 'audio' | 'document_region' | undefined;
  /** The excerpt the generator saw, never generator-authored. */
  excerpt?: string | undefined;
  beliefId?: string | undefined;
  sceneId?: string | undefined;
}

/** `POST /v1/synthesize` — `SynthesizeResponseSchema`. */
export interface SynthesizeResponse {
  /**
   * null when brain abstained rather than answer past its evidence;
   * `reason` says why. On a server in harness mode (`harness_mode`) brain
   * calls no model of its own: `results` carry the evidence to answer from.
   */
  answer: string | null;
  reason?: SynthesisReason | undefined;
  citations: Citation[];
  results: SearchHit[];
  evidenceCitations?: EvidenceCitation[] | undefined;
  decisionLog?: Record<string, unknown>[] | undefined;
  tokenUsage?: { promptTokens: number; completionTokens: number } | undefined;
  /** Served from the answer cache: citations re-validated, `results` empty. */
  cached?: boolean | undefined;
  /**
   * With `model_unavailable`: the stage the provider refused. `verifier`
   * with an answer means the answer is unchecked; `generator` means none.
   */
  degraded?: ('generator' | 'verifier')[] | undefined;
  notice?: ServerModelsNotice | undefined;
}

/** `EntityProfileFactSchema`. */
export interface EntityProfileFact {
  factId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string | undefined;
  expectedUntil?: string | undefined;
  status: string;
}

/** `GET /v1/entities/:id` — `EntityProfileResponseSchema`. */
export interface EntityProfile {
  entityId: string;
  type: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  /** Set when the entity was merged into another: fetch `mergedInto` instead. */
  mergedAt?: string | undefined;
  mergedInto?: string | undefined;
  facts: EntityProfileFact[];
}

/** A fact entered the graph — `TimelineRecordedEventSchema`. */
export interface TimelineRecordedEvent {
  type: 'fact.recorded';
  /** Transaction time: when the memory learned it. */
  at: string;
  /** Valid time: from when the value held in the world. */
  validFrom: string;
  factId: string;
  predicate: string;
  object: string;
  source: unknown;
  confidence: number;
}

/** A fact left the graph — `TimelineRetractedEventSchema`. */
export interface TimelineRetractedEvent {
  type: 'fact.retracted';
  at: string;
  factId: string;
  retractedBy: unknown;
  reason: unknown;
  supersededBy?: string | undefined;
}

export type TimelineEvent = TimelineRecordedEvent | TimelineRetractedEvent;

/** `GET /v1/entities/:id/timeline` — `EntityTimelineResponseSchema`. */
export interface EntityTimeline {
  entityId: string;
  /** Transaction-time sweep, oldest first. */
  events: TimelineEvent[];
}

/**
 * An error response — RFC 9457 problem details, which brain answers every
 * failure with (`application/problem+json`). `type`, `title`, `status`,
 * `detail` and `instance` are the standard members; `requestId` is brain's
 * correlation id, the one to quote in a bug report, and `errors` lists the
 * validation messages of a 400.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string | undefined;
  instance?: string | undefined;
  requestId?: string | undefined;
  errors?: string[] | undefined;
  [extension: string]: unknown;
}
