import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SurrealService, retryOnUniqueViolation } from '../db/surreal.service';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { createEdgeBetween } from './edge-writer';
import { idTailOf } from './ingest-utils';
import { EntityUpsertService } from './entity-upsert.service';

/**
 * The link ingest path (`ingestLink`): declare an edge between two entities, or
 * — for kind `identity_of` — merge one entity into another. Resolves both ends
 * (creating bare entities if absent) then RELATEs idempotently; identity merges
 * route through fn::merge_identity with its atomic cycle guard.
 */
@Injectable()
export class LinkIngestService {
  private readonly logger = new Logger(LinkIngestService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
  ) {}

  async ingestLink(companyId: string, dto: IngestLinkDto) {
    return this.surreal.withCompany(companyId, async (db) => {
      const fromId = await this.entities.resolveOrCreateBareRef(db, dto.from);
      const toId = await this.entities.resolveOrCreateBareRef(db, dto.to);

      // identity_of merge. The merge sets toId.mergedInto = fromId.
      // If fromId already resolves (transitively) back to toId, both ends end
      // up mergedInto-set and BOTH vanish from retrieval (`WHERE mergedInto IS
      // NONE`), since survivor resolution is single-hop.
      //
      // fn::merge_identity (migration 0037) runs the multi-hop cycle guard
      // AND the mergedInto write as a single atomic statement, so the
      // read-decide-write can't be interleaved the way the old separate
      // TS-walk + standalone UPDATE could. A sorted-pair lock row inside the
      // function makes concurrent reverse merges (A→B racing B→A) collide on
      // one record write; retryOnUniqueViolation re-runs the loser, whose
      // second attempt sees the committed merge and trips the cycle guard.
      //
      // Called BEFORE the RELATE so the "reject before any write" contract
      // holds: a cycle / self-merge returns merged=false having written
      // nothing, and we throw before creating the edge.
      if (dto.kind === 'identity_of') {
        if (fromId === toId) {
          throw new BadRequestException('identity_of cannot merge an entity into itself');
        }
        const merge = await retryOnUniqueViolation(async () => {
          const [r] = await db.query<[{ merged: boolean; reason: string | null }]>(
            `RETURN fn::merge_identity(
                type::record('knowledge_entity', $loser),
                type::record('knowledge_entity', $survivor))`,
            { loser: idTailOf(toId), survivor: idTailOf(fromId) },
          );
          return r;
        });
        if (!merge?.merged) {
          if (merge?.reason === 'cycle') {
            throw new BadRequestException(
              'identity_of would create a merge cycle (survivor already resolves to the loser)',
            );
          }
          if (merge?.reason === 'self_merge') {
            // Defensive: the fromId===toId fast-path above already covers
            // this, so the function's own self-merge branch is normally dead.
            throw new BadRequestException('identity_of cannot merge an entity into itself');
          }
          // merged=false with no recognised reason (or a null/unexpected
          // result shape) is NOT a client input error — surface it as such
          // instead of mislabelling it a self-merge 400, so a driver/infra
          // failure is debuggable rather than masked.
          throw new Error(
            `identity_of merge failed unexpectedly (reason=${merge?.reason ?? 'none'})`,
          );
        }
        this.logger.log(
          `[knowledge.entity.merged] companyId=${companyId} loser=${toId} survivor=${fromId}`,
        );
      }

      // Idempotent edge insert through the shared primitive: a replayed
      // webhook returns the existing edge instead of a second copy. The
      // link API declares tenant-global relations (no per-user scope on
      // this surface), so the edge lands in the '' scope.
      const edgeId = await createEdgeBetween(db, {
        fromEntityId: fromId,
        toEntityId: toId,
        kind: dto.kind,
        weight: dto.weight ?? 1.0,
        source: { ...dto.source },
      });

      this.logger.log(
        `[knowledge.edge.created] companyId=${companyId} kind=${dto.kind} ${fromId} → ${toId}`,
      );

      // identity merge (mergedInto write) already happened atomically in
      // fn::merge_identity above, before the RELATE.

      return { edgeId, fromEntityId: fromId, toEntityId: toId, kind: dto.kind };
    });
  }
}
