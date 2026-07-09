import { ServiceUnavailableException } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';

/**
 * Shared gate for the document-pipeline HTTP surface: every route stays
 * dark (503 feature_disabled) until DOCUMENT_INGEST_ENABLED is flipped.
 */
export function assertDocumentIngestEnabled(): void {
  if (!envFlagEnabled(process.env.DOCUMENT_INGEST_ENABLED)) {
    throw new ServiceUnavailableException({
      error: 'feature_disabled',
      message: 'Document ingest is disabled (DOCUMENT_INGEST_ENABLED)',
    });
  }
}

export function docMaxChars(): number {
  const v = process.env.DOC_MAX_CHARS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 512_000;
}
