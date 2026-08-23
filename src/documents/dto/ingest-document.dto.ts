import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Connector context for a document. Mirrors MentionContextRef's role:
 * `vertical` scopes source keys; `recorder` here is the CONNECTOR identity
 * (stored on the source_document row) — committed facts carry the INDEXER
 * as source.recorder, not this value.
 */
export interface DocumentContextRef {
  vertical: string;
  recorder?: string;
}

/** Static hard cap on document text; DOC_MAX_CHARS (env) may lower it. */
export const DOC_TEXT_HARD_CAP = 512_000;

/**
 * OpenAPI mirror: src/contracts/documents/documents.schema.ts
 * (IngestDocumentRequestSchema) — keep field names/optionality/caps in
 * lockstep and regenerate docs/openapi.json on change.
 */
export class IngestDocumentDto {
  /**
   * Container kind the connector normalized from (pdf/markdown/email/
   * whatsapp/github/chat/other...). Open string — the brain doesn't know
   * what a PDF is, this is provenance metadata only.
   */
  @IsString()
  @MaxLength(64)
  kind!: string;

  // Normalized document text. 512K ≈ 32 extractor chunks — large enough
  // for any realistic meeting transcript / contract, small enough that a
  // malicious payload can't blow the OpenAI bill. Connectors with more
  // split into multiple documents.
  @IsString()
  @MaxLength(DOC_TEXT_HARD_CAP)
  text!: string;

  /** Pointer back to the raw container (URL, path, message id…). */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  originUri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  title?: string;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;

  /** The document's own timestamp — becomes the facts' validFrom. */
  @IsISO8601()
  occurredAt!: string;

  @IsObject()
  contextRef!: DocumentContextRef;

  /**
   * Store the normalized text (chunks) server-side. `false` keeps only
   * contentHash + metadata — the privacy trade: such documents cannot be
   * re-indexed when a new pack lands, and external candidates against
   * them cannot be span-re-validated.
   */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  storeContent?: boolean;

  /**
   * Which indexers read this document. Wave 1 supports 'general' (the
   * union generalist pass — mention parity). 'auto' and explicit pack-id
   * lists arrive with dedicated runs (DOCUMENT_MULTI_INDEXER_ENABLED).
   * Accepted as an opaque value; shape-checked in the service — a
   * string-or-array union doesn't survive class-validator whitelisting.
   */
  @IsOptional()
  indexers?: string[] | 'auto' | 'general';

  @IsOptional()
  @IsIn(['sync', 'async'])
  mode?: 'sync' | 'async';
}
