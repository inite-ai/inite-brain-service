import { ServiceUnavailableException } from '@nestjs/common';
import { envFlagNotDisabled } from '../common/env-validation';

/**
 * Shared gate for the document-pipeline HTTP surface.
 *
 * DEFAULT ON. The flag dates from when the pipeline was landing in
 * pieces; it has been complete and covered by e2e specs for a long time,
 * and an operator had no way to tell that the 503 meant "switched off"
 * rather than "broken". Set `DOCUMENT_INGEST_ENABLED=0` to close the
 * surface again — every route then answers 503 feature_disabled and the
 * mention/fact paths behave exactly as before.
 */
export function assertDocumentIngestEnabled(): void {
  if (!envFlagNotDisabled(process.env.DOCUMENT_INGEST_ENABLED)) {
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
 * Read at call time so a flip is runtime-mutable. DEFAULT ON — it is a
 * read-only view over a ledger the tenant already owns, behind the same
 * admin scopes as everything else in /v1/admin. Set `=0` and the routes
 * 404, exactly as if they did not exist.
 */
export function indexerOperatorViewEnabled(): boolean {
  return envFlagNotDisabled(process.env.INDEXER_OPERATOR_VIEW_ENABLED);
}

export function docMaxChars(): number {
  const v = process.env.DOC_MAX_CHARS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 512_000;
}
