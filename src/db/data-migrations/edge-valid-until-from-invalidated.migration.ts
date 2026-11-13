import { Injectable } from '@nestjs/common';
import { IdBatchMigration } from './id-batch-migration';

/**
 * 0164's second backfill, done again safely. Before 0164 the edge closure
 * wrote the valid-time close into invalidatedAt, clamped to createdAt, so
 * that value is the edge's validUntil; a close at or before the write
 * means the relation was recorded only as having ended, and its start is
 * unknown. 0164 defined `edge_valid_until_idx` in the same file, and its
 * `UPDATE … WHERE validUntil IS NONE …` missed one production edge.
 *
 * Every writer since 0164 sets validUntil whenever it sets invalidatedAt
 * (edge-writer.ts, fact-resolver.service.ts, dreams/edge-resolution.ts), so
 * a row with the second and not the first is only ever a pre-0164 row.
 */
@Injectable()
export class EdgeValidUntilFromInvalidatedMigration extends IdBatchMigration {
  readonly id = 'edge_valid_until_from_invalidated';
  readonly description =
    'Give pre-0164 closed knowledge edges their valid-time close from invalidatedAt (re-applies 0164)';
  protected readonly table = 'knowledge_edge';
  protected readonly where = 'validUntil IS NONE AND invalidatedAt IS NOT NONE';
  protected readonly set =
    'validFrom = IF invalidatedAt > createdAt THEN createdAt ELSE NONE END, validUntil = invalidatedAt';
}
