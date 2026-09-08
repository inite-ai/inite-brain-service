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

/**
 * The read-only operator view over installed indexers and their run
 * health (GET /v1/admin/indexers, INDEXER_OPERATOR_VIEW_ENABLED).
 * Deliberately its OWN flag rather than riding DOCUMENT_INGEST_ENABLED:
 * this is a new read surface over an existing ledger, and a tenant should
 * be able to open it (or not) independently of the write pipeline.
 * Read at call time so a flip is runtime-mutable. Default off ⇒ the
 * routes 404, exactly as if they did not exist.
 */
export function indexerOperatorViewEnabled(): boolean {
  return envFlagEnabled(process.env.INDEXER_OPERATOR_VIEW_ENABLED);
}

export function docMaxChars(): number {
  const v = process.env.DOC_MAX_CHARS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 512_000;
}
