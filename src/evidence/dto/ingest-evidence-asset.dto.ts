import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EVIDENCE_MODALITIES, type EvidenceModality } from '../../common/evidence-taxonomy';
import { MEDIA_PII_CLASSES, type MediaPiiClass } from '../../common/media-pii';
import { IngestEvidenceFragmentDto } from './ingest-evidence-fragment.dto';

export { IngestEvidenceFragmentDto } from './ingest-evidence-fragment.dto';

/**
 * Wire shape of POST /v1/ingest/evidence-asset (EVIDENCE_INGEST_ENABLED,
 * default off → 404). METADATA-ONLY by design (the MM-6 quarantine
 * boundary): the caller registers what an observation IS and WHERE it
 * lives (`originUri`, a caller-owned location the brain never fetches) —
 * never the bytes themselves. `storageRef` is deliberately NOT part of
 * this contract: the global `forbidNonWhitelisted` pipe rejects it with
 * 400, so blob-backed registration stays a service-level concern until
 * the upload/quarantine design lands.
 *
 * `byteHash` is REQUIRED — a deliberate narrowing of the "if known"
 * draft: 0109 makes byteHash the UNIQUE asset identity, so an optional
 * hash could not be honored without inventing a second identity law.
 */

/** Fragment caps: a request is a registration, not a bulk import. */
const FRAGMENTS_MAX = 64;
/** Opaque pointer, not fetched — bounded against abuse only. */
const ORIGIN_URI_MAX = 2_048;

export class IngestEvidenceAssetDto {
  @IsIn(EVIDENCE_MODALITIES)
  modality!: EvidenceModality;

  /** IANA type/subtype — the exact shape is enforced at the write seam. */
  @IsString()
  @MaxLength(255)
  mediaType!: string;

  /**
   * sha256 hex of the ORIGINAL bytes — the UNIQUE asset identity (0109).
   * Required (see the class doc); 64 lowercase hex enforced at the seam.
   */
  @IsString()
  @MaxLength(64)
  byteHash!: string;

  /** Declared size; capped by EVIDENCE_MAX_BYTES at the write seam. */
  @IsInt()
  @Min(1)
  byteLength!: number;

  /** When the observation happened (ISO-8601). */
  @IsISO8601()
  occurredAt!: string;

  /**
   * Caller-owned external location of the bytes. REQUIRED on this
   * surface: with no bytes and no storageRef accepted, an asset without
   * an origin would be unresolvable metadata (availability is always
   * 'external' for a fresh registration here). Never fetched.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(ORIGIN_URI_MAX)
  originUri!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  vertical!: string;

  /** Per-user scope (0055 discipline): fail-closed reads for others. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @ArrayMaxSize(32)
  scope?: string[] | undefined;

  /**
   * Media PII classes present in the asset (fail-closed polarity:
   * absent = unclassified = blocked; `[]` = affirmatively clean).
   */
  @IsOptional()
  @IsArray()
  @IsIn(MEDIA_PII_CLASSES, { each: true })
  piiClasses?: MediaPiiClass[] | undefined;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  recorder?: string | undefined;

  /** Retention horizon; past it the sweeper tombstones the asset. */
  @IsOptional()
  @IsISO8601()
  retainUntil?: string | undefined;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown> | undefined;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number | undefined;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number | undefined;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationMs?: number | undefined;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageCount?: number | undefined;

  /**
   * Citation-target fragments created with the asset. Every locator is
   * validated against the modality matrix BEFORE the asset row is
   * written — one bad locator fails the whole request with 400 and
   * writes nothing.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FRAGMENTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => IngestEvidenceFragmentDto)
  fragments?: IngestEvidenceFragmentDto[] | undefined;
}
