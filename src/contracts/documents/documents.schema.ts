import { z } from 'zod';

/**
 * Wire contracts for the document pipeline's PLATFORM surface
 * (/v1/ingest/document, /v1/documents/:id, /v1/documents/:id/candidates).
 *
 * SPEC MIRRORS, not runtime validators. The request schemas mirror the
 * class-validator DTOs that actually validate these bodies at runtime —
 * src/documents/dto/ingest-document.dto.ts and submit-candidates.dto.ts —
 * field-for-field (names, optionality, length caps). The response schemas
 * mirror the service interfaces (DocumentIngestResponse,
 * DocumentAsyncResponse, StoredDocument, CandidateRow,
 * ExternalSubmissionResult). When a DTO or response interface changes,
 * change the mirror here and regenerate docs/openapi.json
 * (`pnpm openapi:build`); test/openapi-doc.unit-spec.ts gates the drift.
 */

/** Mirror of DocumentContextRef (src/documents/dto/ingest-document.dto.ts). */
export const DocumentContextRefSchema = z.object({
  vertical: z.string(),
  /** CONNECTOR identity; committed facts carry the INDEXER as recorder. */
  recorder: z.string().optional(),
});

/** Mirror of IngestDocumentDto — runtime cap DOC_TEXT_HARD_CAP = 512_000. */
export const IngestDocumentRequestSchema = z.object({
  kind: z
    .string()
    .max(64)
    .describe(
      'Container kind the connector normalized from (pdf/markdown/email/…). ' +
        'Open string — provenance metadata only.',
    ),
  text: z
    .string()
    .max(512_000)
    .describe('Normalized document text (DOC_MAX_CHARS may lower the cap).'),
  originUri: z
    .string()
    .max(512)
    .optional()
    .describe('Pointer back to the raw container (URL, path, message id…).'),
  title: z.string().max(512).optional(),
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Operator-supplied metadata, projected onto derived facts' source.meta."),
  occurredAt: z.string().meta({
    format: 'date-time',
    description: "ISO 8601 — becomes the derived facts' validFrom.",
  }),
  contextRef: DocumentContextRefSchema,
  storeContent: z
    .boolean()
    .optional()
    .describe(
      'Store the normalized chunks server-side. false keeps only ' +
        'contentHash + metadata (no re-index, no span re-validation).',
    ),
  indexers: z
    .union([z.literal('general'), z.literal('auto'), z.array(z.string())])
    .optional()
    .describe("'general' (union pass), 'auto' (router-selected), or explicit pack ids."),
  mode: z
    .enum(['sync', 'async'])
    .optional()
    .describe("'async' requires DOCUMENT_MULTI_INDEXER_ENABLED and storeContent."),
  toolObservationRef: z
    .string()
    .max(160)
    .optional()
    .describe(
      'Provenance hop to the tool result this document derives from ' +
        '(tool_observation:<id>, migration 0111). Honored only under ' +
        "TOOL_OBSERVATIONS_ENABLED; folded into committed facts' source.evidence[].",
    ),
});

/** Shared commit tally (CommitResult['counts']). */
export const CommitCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  committed: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});

/** Mirror of DocumentIngestResponse (document-ingest.service.ts). */
export const IngestDocumentSyncResponseSchema = z.object({
  documentId: z.string(),
  deduplicated: z.boolean(),
  chunkCount: z.number().int().nonnegative(),
  mode: z.literal('sync'),
  runs: z.array(z.object({ runId: z.string(), packId: z.string(), status: z.string() })),
  committed: z.object({
    entityIds: z.array(z.string()),
    factIds: z.array(z.string()),
    edgeIds: z.array(z.string()),
  }),
  counts: CommitCountsSchema,
});

/** Mirror of DocumentAsyncResponse (document-async.service.ts). */
export const IngestDocumentAsyncResponseSchema = z.object({
  documentId: z.string(),
  deduplicated: z.boolean(),
  chunkCount: z.number().int().nonnegative(),
  mode: z.literal('async'),
  runs: z.array(
    z.object({
      packId: z.string(),
      /** 'planned' = an external pack's pull-API work item was registered. */
      status: z.enum(['enqueued', 'already_processed', 'planned']),
    }),
  ),
});

/** Mirror of DocumentChunk (src/documents/chunker.ts). */
export const DocumentChunkSchema = z.object({
  seq: z.number().int().nonnegative(),
  text: z.string(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
});

/**
 * Mirror of the GET /v1/documents/:id response — StoredDocument
 * (document-store.service.ts) + its indexer runs; `chunks` only with
 * ?includeText=1 (scope brain:read_pii).
 */
export const DocumentResponseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  contentHash: z.string(),
  charLen: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  hasContent: z.boolean(),
  vertical: z.string(),
  recorder: z.string().optional(),
  occurredAt: z.string().meta({ format: 'date-time' }),
  status: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  runs: z.array(
    z.object({
      runId: z.string(),
      packId: z.string(),
      packVersion: z.string(),
      status: z.string(),
    }),
  ),
  chunks: z.array(DocumentChunkSchema).optional(),
});

/** Mirror of CandidateRow (candidate-store.service.ts). */
export const CandidateSchema = z.object({
  id: z.string(),
  runId: z.string(),
  chunkSeq: z.number().int(),
  kind: z.enum(['entity', 'fact', 'relation']),
  confidence: z.number(),
  status: z.string(),
  statusReason: z.string().optional(),
  commitRef: z.string().optional(),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      'Extraction payload. `object`/`clause` of scope-gated fact candidates ' +
        'are redacted for callers without the required predicate scope.',
    ),
});

export const DocumentCandidatesResponseSchema = z.object({
  documentId: z.string(),
  candidates: z.array(CandidateSchema),
});

/** Mirror of SubmittedEntity (src/documents/dto/submit-candidates.dto.ts). */
export const SubmittedEntitySchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  canonical: z.string().optional(),
});

/** Mirror of SubmittedFact — entityIndex is LOCAL to this batch. */
export const SubmittedFactSchema = z.object({
  entityIndex: z.number().int().nonnegative(),
  predicate: z.string().describe('Must be namespaced `<indexerId>__*` or a core predicate.'),
  object: z.string(),
  confidence: z.number().optional(),
  clause: z.string().optional(),
});

/** Mirror of SubmittedRelation. */
export const SubmittedRelationSchema = z.object({
  fromEntityIndex: z.number().int().nonnegative(),
  toEntityIndex: z.number().int().nonnegative(),
  kind: z.string(),
  confidence: z.number().optional(),
});

/** Mirror of SubmitCandidatesDto (top-level class-validated; item shapes
 *  service-validated — ≤200 items per kind). */
export const SubmitCandidatesRequestSchema = z.object({
  indexerId: z
    .string()
    .max(64)
    .describe("The pack id this indexer is registered as (mode 'external')."),
  packVersion: z
    .string()
    .max(32)
    .optional()
    .describe('Optional claim of the pack version; must match the installed one.'),
  runId: z
    .string()
    .max(128)
    .optional()
    .describe(
      'A claimed work item this submission fulfils. Provided together with ' +
        'claimToken or not at all (claimless flow opens its own run).',
    ),
  claimToken: z.string().max(64).optional(),
  entities: z.array(SubmittedEntitySchema),
  facts: z.array(SubmittedFactSchema),
  relations: z.array(SubmittedRelationSchema).optional(),
});

/** Mirror of GroundingDrop (candidate-grounding.ts). */
export const GroundingDropSchema = z.object({
  kind: z.enum(['entity', 'fact', 'relation']),
  index: z.number().int().nonnegative(),
  reason: z.enum(['ungrounded_entity', 'ungrounded_value', 'orphan_reference']),
  detail: z.string(),
});

/**
 * Mirror of the POST /v1/documents/:id/candidates response —
 * ExternalSubmissionResult (external-candidates.service.ts) + the
 * commit-if-settled outcome the controller appends.
 */
export const SubmitCandidatesResponseSchema = z.object({
  runId: z.string(),
  packId: z.string(),
  packVersion: z.string(),
  staged: z.object({
    entities: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
  }),
  dropped: z.array(GroundingDropSchema),
  ungrounded: z
    .boolean()
    .describe('true when the document has no stored content — spans unverifiable.'),
  commit: z
    .object({
      deferred: z.boolean(),
      committed: z.boolean(),
      counts: CommitCountsSchema,
    })
    .nullable()
    .describe('null when the document vanished between staging and commit.'),
});

/** Mirror of HeartbeatWorkDto (src/documents/dto/heartbeat-work.dto.ts). */
export const HeartbeatWorkRequestSchema = z.object({
  claimToken: z.string().max(64),
});

/** Mirror of FailWorkDto (src/documents/dto/fail-work.dto.ts). */
export const FailWorkRequestSchema = z.object({
  claimToken: z.string().max(64),
  error: z
    .string()
    .max(2_000)
    .optional()
    .describe('Optional diagnostic recorded on the run row (truncated server-side).'),
  permanent: z
    .boolean()
    .optional()
    .describe(
      "Default (false/absent) RELEASES the item back to 'pending'; true " +
        "marks the run 'failed' — no longer offered, still claimable by runId.",
    ),
});

export type HeartbeatWorkRequest = z.infer<typeof HeartbeatWorkRequestSchema>;
export type FailWorkRequest = z.infer<typeof FailWorkRequestSchema>;
export type IngestDocumentRequest = z.infer<typeof IngestDocumentRequestSchema>;
export type IngestDocumentSyncResponse = z.infer<typeof IngestDocumentSyncResponseSchema>;
export type IngestDocumentAsyncResponse = z.infer<typeof IngestDocumentAsyncResponseSchema>;
export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;
export type DocumentCandidatesResponse = z.infer<typeof DocumentCandidatesResponseSchema>;
export type SubmitCandidatesRequest = z.infer<typeof SubmitCandidatesRequestSchema>;
export type SubmitCandidatesResponse = z.infer<typeof SubmitCandidatesResponseSchema>;
