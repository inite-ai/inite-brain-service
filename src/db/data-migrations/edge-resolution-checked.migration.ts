import { Injectable } from '@nestjs/common';
import { IdBatchMigration } from './id-batch-migration';

/**
 * 0182's backfill, done again safely. An edge already closed on either axis
 * has nothing for edge resolution to judge, so it is marked checked. 0182's
 * `UPDATE knowledge_edge … WHERE resolutionCheckedAt IS NONE …` ran with
 * `edge_resolution_checked_idx` defined two lines above it and, on 3.2.4,
 * did nothing: on production 20 closed edges across 3 tenants stayed NONE
 * with 0182 recorded as applied.
 */
@Injectable()
export class EdgeResolutionCheckedMigration extends IdBatchMigration {
  readonly id = 'edge_resolution_checked';
  readonly description =
    'Mark closed knowledge edges as already judged by edge resolution (re-applies 0182)';
  protected readonly table = 'knowledge_edge';
  protected readonly where =
    'resolutionCheckedAt IS NONE AND (validUntil IS NOT NONE OR invalidatedAt IS NOT NONE)';
  protected readonly set = 'resolutionCheckedAt = time::now()';
}
