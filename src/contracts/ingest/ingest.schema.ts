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

export type IngestFactRequest = z.infer<typeof IngestFactRequestSchema>;
export type IngestFactResponse = z.infer<typeof IngestFactResponseSchema>;
