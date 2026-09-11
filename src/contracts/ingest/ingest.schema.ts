import { z } from 'zod';

/**
 * Wire contracts for the headline write — POST /v1/ingest/fact.
 *
 * Request mirrors IngestFactDto (src/ingest/dto/ingest-fact.dto.ts) and
 * the interfaces it carries (EntityRef, FactSource, SourceEvidence);
 * response mirrors IngestResult (src/ingest/ingest-result.ts). Parity is
 * pinned by test/contracts-ingest.unit-spec.ts.
 *
 * `entityRef`, `source` and `metadata` are LOOSE objects on purpose:
 * class-validator sees them as opaque `@IsObject()` fields (a union /
 * open shape can't survive `forbidNonWhitelisted` nesting), so their
 * inner keys are shape-checked by FactIngestService rather than the
 * pipe — an extra key inside them is not a 400. The published schema
 * says exactly that.
 */

/** One supporting observation behind a fact — ≤10 per source. */
export const SourceEvidenceSchema = z.object({
  kind: z.enum(['event', 'message', 'conversation', 'url', 'document', 'commit', 'other']),
  /** The pointer itself — id, URL, path, sha… ≤512 chars. */
  ref: z.string(),
  note: z.string().optional(),
});

/**
 * Which entity the fact is about. Either a (vertical, id) pair — the
 * dedup key, which a `userId` additionally scopes to that end user — or
 * a bare `entityId` naming an existing row.
 */
export const EntityRefSchema = z.looseObject({
  vertical: z.string().optional(),
  id: z.string().optional(),
  entityId: z.string().optional(),
});

/**
 * Where the claim came from. Stored verbatim inside the FLEXIBLE
 * `knowledge_fact.source`. `originKey` is NOT part of this contract —
 * FactIngestService strips any client-supplied value.
 */
export const FactSourceSchema = z.looseObject({
  vertical: z.string(),
  eventId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  recorder: z.string().optional(),
  /** Supporting observations behind the claim — ≤10 entries. */
  evidence: z.array(SourceEvidenceSchema).optional(),
  /**
   * Grounding episode record ids (`episode:…`) — ≤64 entries, validated
   * only while EVIDENCE_GROUNDING_STAMP is on, so a caller cannot spoof
   * grounded status with garbage.
   */
  episodeIds: z.array(z.string()).optional(),
});

export const IngestFactRequestSchema = z.strictObject({
  entityRef: EntityRefSchema,
  predicate: z.string().max(256),
  /** A single fact value (price, address, name…). Prose belongs in mention text. */
  object: z.string().max(2_000),
  /** ISO-8601 start of the fact's validity window. */
  validFrom: z.string(),
  validUntil: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: FactSourceSchema,
  /**
   * Per-user memory scope (migration 0055): the fact — and, for a
   * (vertical, id) ref, the entity dedup key — is stamped with this end
   * user, invisible to every other user of the tenant. Conflict
   * resolution is scope-local.
   */
  userId: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Emit `conflictExplanation` when the outcome is SUPERSEDED or COMPETING. */
  explain: z.boolean().optional(),
});

/**
 * The deterministic conflict narrative (src/ingest/conflict-explainer.ts).
 * Deliberately NOT field-level contracted — like `breakdown` on a search
 * hit and `decisionLog` on a synthesis, this is an `explain`-mode DEBUG
 * payload built from the resolver's internal score dimensions, and
 * pinning it here would publish a promise the resolver never made.
 */
export const ConflictExplanationSchema = z.record(z.string(), z.unknown());

export const IngestFactResponseSchema = z.object({
  /** null when the resolver REJECTED the claim. */
  factId: z.string().nullable(),
  outcome: z.enum([
    'INSERTED',
    /** Backdated insert: recorded as an already-superseded historical row (0043). */
    'INSERTED_HISTORICAL',
    /** Same claim from a DIFFERENT source — kept as audit, incumbent's counter grew (0047). */
    'CORROBORATED',
    'SUPERSEDED',
    'COMPETING',
    'REJECTED',
  ]),
  supersededFactIds: z.array(z.string()).optional(),
  competingFactIds: z.array(z.string()).optional(),
  /** INSERTED_HISTORICAL only: the newer fact the backdated row was slotted behind. */
  supersededByFactId: z.string().optional(),
  /** CORROBORATED only: the incumbent this claim confirmed. */
  corroboratedFactId: z.string().optional(),
  reason: z.string().optional(),
  conflictExplanation: ConflictExplanationSchema.optional(),
});

/**
 * Where a mention came from. Optional as a whole — a conversational
 * capture has text and a user and nothing else it can honestly fill in
 * — and defaulted to the `chat` vertical at the surface.
 */
export const MentionContextRefSchema = z.looseObject({
  vertical: z.string(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  eventId: z.string().optional(),
  /**
   * The producer of the mention, keyed into source trust as
   * `vertical:recorder`. Absent defaults to the extraction model id, so
   * LLM-extracted facts get a per-model trust bucket.
   */
  recorder: z.string().optional(),
});

/** A participant already known to the caller, for coreference anchoring. */
export const KnownEntitySchema = z.looseObject({
  vertical: z.string(),
  id: z.string(),
  /** `speaker` resolves first person, `addressee` resolves second. */
  role: z.string().optional(),
  name: z.string().optional(),
});

/**
 * The simplest write: free text in, facts out. Only `text` is required —
 * everything else has a surface default — which is what makes the
 * two-line quickstart honest rather than a trimmed example.
 */
export const IngestMentionRequestSchema = z.strictObject({
  /** ≤16 000 chars; the extractor truncates server-side as a backstop. */
  text: z.string().max(16_000),
  /** Defaults to `{ vertical: 'chat' }`. */
  contextRef: MentionContextRefSchema.optional(),
  knownEntities: z.array(KnownEntitySchema).optional(),
  /**
   * Per-user memory scope (migration 0055) — stamps the captured episode
   * turn and every extracted fact. A user-bound token pins it to its own
   * user; a mismatch is 403.
   */
  userId: z.string().max(200).optional(),
  /** ISO-8601 event time. Defaults to the moment the request arrives. */
  emittedAt: z.string().optional(),
  /** IANA zone of the speaker's session, anchoring relative dates. */
  timezone: z.string().max(64).optional(),
});

export const IngestMentionResponseSchema = z.object({
  /** true when nothing was extracted — `reason` says why. */
  skipped: z.boolean(),
  reason: z.string().optional(),
  extractedEntityIds: z.array(z.string()),
  extractedFactIds: z.array(z.string()),
  extractedEdgeIds: z.array(z.string()).optional(),
});

export type IngestFactRequest = z.infer<typeof IngestFactRequestSchema>;
export type IngestFactResponse = z.infer<typeof IngestFactResponseSchema>;
export type IngestMentionRequest = z.infer<typeof IngestMentionRequestSchema>;
export type IngestMentionResponse = z.infer<typeof IngestMentionResponseSchema>;
