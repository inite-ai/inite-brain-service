import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { EVIDENCE_MODALITIES, type EvidenceModality } from '../../common/evidence-taxonomy';
import { MEDIA_PII_CLASSES, type MediaPiiClass } from '../../common/media-pii';

/**
 * Wire shape of the metadata half of POST /v1/ingest/evidence-blob
 * (`multipart/form-data`; the bytes ride the `file` part).
 * EVIDENCE_BLOB_UPLOAD_ENABLED, default off → 404.
 *
 * SERVER-OWNED, therefore absent here on purpose:
 *
 *   - `byteHash` — sha256 of the bytes the server actually received. On
 *     the metadata-only sibling route the hash is a caller assertion
 *     because the caller keeps the bytes; here the server takes custody,
 *     so it computes the 0109 identity itself. A caller-supplied hash
 *     could only ever disagree with the bytes, and a disagreement has no
 *     honest resolution.
 *   - `byteLength` — likewise measured, not declared.
 *   - `storageRef` — minted by the storage adapter.
 *   - `origin` — always 'external_ingest': bytes crossing an HTTP
 *     boundary ARE external ingest (the MM-6 doctrine), which is why the
 *     surface needs EVIDENCE_QUARANTINE.
 *
 * Every field below arrives as a multipart TEXT part, i.e. a string.
 * Numbers are converted with @Type (a non-numeric value becomes NaN and
 * fails @IsInt — a clean 400, never a silent 0), and the two list fields
 * are comma-separated because a repeated multipart field name would make
 * "one value" and "a list of one" indistinguishable.
 */

/** Max entries in a comma-separated `scope` list — mirrors the JSON DTO. */
const SCOPE_MAX = 32;

/**
 * Split a comma-separated multipart field into a trimmed list. The EMPTY
 * STRING maps to `[]`, which is load-bearing for `piiClasses`: under the
 * media fail-closed polarity (src/common/media-pii.ts) an absent field
 * means "unclassified ⇒ blocked" while `[]` means "a classifier looked
 * and found nothing ⇒ open". Multipart has no null, so the empty string
 * is the only way to say the second thing — and dropping empty segments
 * makes `a,,b` mean `[a, b]` rather than smuggling a blank class in.
 */
function splitList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export class UploadEvidenceBlobDto {
  @IsIn(EVIDENCE_MODALITIES)
  modality!: EvidenceModality;

  /**
   * Overrides the uploaded part's own Content-Type. Optional: the part
   * usually declares it. Either way the effective value is checked
   * against the upload allowlist AND against `modality` — see
   * src/evidence/upload-media-types.ts.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  mediaType?: string | undefined;

  /** When the observation happened (ISO-8601). */
  @IsISO8601()
  occurredAt!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  vertical!: string;

  /** Per-user scope (0055 discipline): fail-closed reads for others. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;

  /** Comma-separated scope tags (0093). */
  @IsOptional()
  @Transform(({ value }) => splitList(value))
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @ArrayMaxSize(SCOPE_MAX)
  scope?: string[] | undefined;

  /**
   * Comma-separated media PII classes. Fail-closed polarity: field absent
   * = unclassified = blocked; empty string = affirmatively clean.
   */
  @IsOptional()
  @Transform(({ value }) => splitList(value))
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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  width?: number | undefined;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  height?: number | undefined;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMs?: number | undefined;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageCount?: number | undefined;

  /**
   * Installed pack to dispatch processors for once the asset is
   * registered and scanned clean. Optional, and FIRE-AND-FORGET: an
   * unknown pack, a pack without modality consent, or a failing adapter
   * is logged and never touches the upload's response (respects
   * EVIDENCE_PROCESSOR_BROKER — off ⇒ nothing is dispatched at all). The
   * admin maintenance sweep is the way to (re)dispatch after the fact.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  packId?: string | undefined;
}
