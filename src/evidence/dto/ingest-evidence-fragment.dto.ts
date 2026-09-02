import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { MEDIA_PII_CLASSES, type MediaPiiClass } from '../../common/media-pii';

/** Label cap mirrors LABEL_MAX at the write seam (0106 sceneLabel). */
const LABEL_MAX = 200;
/** An excerpt is a quotation, not a document. */
const EXCERPT_MAX = 4_000;
/** BCP-47 language tags fit well under this (RFC 5646 recommends 35). */
const LANG_MAX = 35;

/**
 * One citation-target fragment inside POST /v1/ingest/evidence-asset
 * (see ingest-evidence-asset.dto.ts for the surface contract).
 */
export class IngestEvidenceFragmentDto {
  /**
   * Kind-discriminated locator (charRange / pageRegion / timeRange /
   * frameRange / track). A union — accepted as an opaque object here
   * (the ingest-fact.dto.ts precedent: @ValidateNested + the
   * forbidNonWhitelisted pipe strips union members) and shape-checked
   * against the parent asset's modality by validateLocator BEFORE any
   * row is written.
   */
  @IsObject()
  locator!: Record<string, unknown>;

  /** Human label; redacted then capped at the write seam. */
  @IsOptional()
  @IsString()
  @MaxLength(LABEL_MAX)
  label?: string | undefined;

  /**
   * Media PII classes present IN THIS FRAGMENT (fail-closed polarity:
   * absent = unclassified = blocked; `[]` = affirmatively clean).
   */
  @IsOptional()
  @IsArray()
  @IsIn(MEDIA_PII_CLASSES, { each: true })
  piiClasses?: MediaPiiClass[] | undefined;

  /**
   * Caller-asserted text excerpt of the fragment (the quoted passage a
   * charRange points at, a transcript line…). Lands as a
   * derived_representation of kind 'text' with producerVersion
   * 'ingest-excerpt-v1' — asserted, not model-derived.
   */
  @IsOptional()
  @IsString()
  @MaxLength(EXCERPT_MAX)
  excerpt?: string | undefined;

  /** Language of the excerpt (BCP-47). */
  @IsOptional()
  @IsString()
  @MaxLength(LANG_MAX)
  lang?: string | undefined;
}
