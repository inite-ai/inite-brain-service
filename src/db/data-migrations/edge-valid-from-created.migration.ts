import { Injectable } from '@nestjs/common';
import { IdBatchMigration } from './id-batch-migration';

/**
 * An open edge with no start. 0164 gave every open edge `validFrom =
 * createdAt` (the moment it was said, when it names no day), but one writer
 * kept creating edges without it: the dreams dedup pass's `identity_of`
 * link (DedupService.linkIdentity), fixed alongside this migration. On
 * production the newest such edge is from 2026-11-04.
 *
 * Only OPEN edges (no validUntil, no invalidatedAt) are touched: an edge
 * stated only as having ended carries NONE on purpose (start unknown), and
 * so does a relation closed at or before its own write.
 */
@Injectable()
export class EdgeValidFromCreatedMigration extends IdBatchMigration {
  readonly id = 'edge_valid_from_created';
  readonly description =
    'Give open knowledge edges written without a start validFrom = createdAt (0164 semantics)';
  protected readonly table = 'knowledge_edge';
  protected readonly where = 'validFrom IS NONE AND validUntil IS NONE AND invalidatedAt IS NONE';
  protected readonly set = 'validFrom = createdAt';
}
