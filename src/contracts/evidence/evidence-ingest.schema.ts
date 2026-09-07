import { z } from 'zod';
import { EVIDENCE_MODALITIES } from '../../common/evidence-taxonomy';
import { MEDIA_PII_CLASSES, type MediaPiiClass } from '../../common/media-pii';

/**
 * Wire contracts for the metadata-only evidence ingest surface
 * (POST /v1/ingest/evidence-asset — EVIDENCE_INGEST_ENABLED, default
 * off → 404). METADATA-ONLY (MM-6 boundary): `originUri` required,
 * `storageRef` rejected, no bytes ever cross this surface.
 *
 * Runtime truth lives at the write seam (evidence-store.service.ts +
 * locator.ts): the DTO/pipe layer enforces the same caps and the locator
 * matrix BEFORE any row is written; these schemas document the wire.
 */

/** Media PII vocabulary — canonical union in src/common/media-pii.ts. */
const MediaPiiClassSchema = z.enum([...MEDIA_PII_CLASSES] as [MediaPiiClass, ...MediaPiiClass[]]);

/**
 * Kind-discriminated "where in the asset" locator, cross-checked against
 * the parent asset's modality (charRange→document; pageRegion→document |
 * image, image ⇒ page 0; timeRange/track→audio|video|sensor;
 * frameRange→video). Mirror of src/evidence/locator.ts.
 */
export const EvidenceFragmentLocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('charRange'),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('pageRegion'),
    page: z.number().int().nonnegative(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal('timeRange'),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('frameRange'),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('track'),
    trackId: z.string().min(1).max(256),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().nonnegative().optional(),
  }),
]);

export const IngestEvidenceFragmentSchema = z.object({
  locator: EvidenceFragmentLocatorSchema,
  /** Human label; PII-redacted then capped server-side. */
  label: z.string().max(200).optional(),
  /** Fail-closed polarity: absent = unclassified = blocked; [] = clean. */
  piiClasses: z.array(MediaPiiClassSchema).optional(),
  /**
   * Caller-asserted text excerpt — lands as a derived_representation of
   * kind 'text' (producerVersion 'ingest-excerpt-v1').
   */
  excerpt: z.string().min(1).max(4000).optional(),
  /** Language of the excerpt (BCP-47). */
  lang: z.string().max(35).optional(),
});

export const IngestEvidenceAssetRequestSchema = z.object({
  modality: z.enum(EVIDENCE_MODALITIES),
  /** IANA type/subtype (e.g. image/jpeg). */
  mediaType: z.string().max(255),
  /**
   * sha256 hex of the ORIGINAL bytes — REQUIRED: the UNIQUE asset
   * identity (0109). Same-user re-registration dedupes; a different
   * principal gets a bare 409.
   */
  byteHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Declared size in bytes; capped by EVIDENCE_MAX_BYTES. */
  byteLength: z.number().int().positive(),
  /** When the observation happened (ISO-8601). */
  occurredAt: z.string(),
  /**
   * Caller-owned external location of the bytes — REQUIRED (metadata-
   * only surface; a fresh registration is always availability
   * 'external'). Never fetched by the brain.
   */
  originUri: z.string().min(1).max(2048),
  vertical: z.string().min(1).max(200),
  /** Per-user scope: invisible to other users, fail-closed reads. */
  userId: z.string().max(200).optional(),
  scope: z.array(z.string().max(200)).max(32).optional(),
  /** Fail-closed polarity: absent = unclassified = blocked; [] = clean. */
  piiClasses: z.array(MediaPiiClassSchema).optional(),
  recorder: z.string().max(200).optional(),
  /** Retention horizon (ISO-8601); past it the asset is tombstoned. */
  retainUntil: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
  pageCount: z.number().int().positive().optional(),
  /** Citation-target fragments; all locators validated before any write. */
  fragments: z.array(IngestEvidenceFragmentSchema).max(64).optional(),
});

export const IngestEvidenceFragmentResultSchema = z.object({
  fragmentId: z.string(),
  /** Present when the fragment carried an excerpt. */
  representationId: z.string().optional(),
});

/**
 * Response of the BYTE surface (POST /v1/ingest/evidence-blob —
 * EVIDENCE_BLOB_UPLOAD_ENABLED, default off → 404). The request is
 * `multipart/form-data`, so its shape is documented inline on the path
 * rather than as a zod object: the bytes ride the `file` part and every
 * metadata field arrives as a text part.
 *
 * Identity fields are echoed because the SERVER produced them — byteHash
 * is sha256 over the bytes actually received (not a caller assertion, as
 * on the metadata surface), byteLength is measured, storageRef is minted
 * by the storage adapter, and mediaType is the canonical (parameter-free,
 * lowercased) form that the row stores.
 */
export const UploadEvidenceBlobResponseSchema = z.object({
  assetId: z.string(),
  /** 'hot' for a fresh upload; a same-user dedup echoes the stored state. */
  availability: z.enum(['hot', 'cold', 'external', 'gone']),
  /** True when these exact bytes were already this user's asset. */
  deduped: z.boolean(),
  byteHash: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive(),
  storageRef: z.string(),
  mediaType: z.string(),
  /**
   * Post-scan state. 'clean' = scanned and dispatchable. 'scanning' =
   * the scan hook could not render a verdict, so the asset stays
   * quarantined and dispatch-denied (fail closed) and is re-scannable —
   * the upload is NOT silently treated as clean. A 'rejected' verdict
   * never appears here: it answers 422 with the row tombstoned and the
   * bytes deleted.
   */
  quarantineStatus: z.enum(['clean', 'scanning']),
  /**
   * Whether a processor dispatch was STARTED for the requested packId —
   * never whether it succeeded. Dispatch is fire-and-forget by design: a
   * failing adapter must not fail an ingestion whose bytes are already
   * stored, registered and scanned.
   */
  dispatched: z.boolean(),
});

export const IngestEvidenceAssetResponseSchema = z.object({
  assetId: z.string(),
  /**
   * 'external' for a fresh metadata-only registration; a same-user
   * dedup returns the EXISTING asset's state, which may be blob-backed.
   */
  availability: z.enum(['hot', 'cold', 'external', 'gone']),
  /** True when byteHash matched this user's existing asset. */
  deduped: z.boolean(),
  fragments: z.array(IngestEvidenceFragmentResultSchema),
});
