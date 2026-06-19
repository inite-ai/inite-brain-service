import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService, dbMerge } from '../db/surreal.service';
import { RetractFactDto } from './dto/retract.dto';

export interface RetractResult {
  factId: string;
  retractedAt: string;
  cascadedFactIds: string[];
  /**
   * Facts that were previously superseded by the retracted fact and
   * have now been brought back to status='active'. Empty when the
   * retracted fact never superseded anything, or when every
   * predecessor was itself separately retracted (we don't revive a
   * row that was explicitly retracted on its own merits).
   */
  revivedFactIds: string[];
}

@Injectable()
export class FactsService {
  private readonly logger = new Logger(FactsService.name);

  constructor(private readonly surreal: SurrealService) {}

  async retract(
    companyId: string,
    factId: string,
    dto: RetractFactDto,
  ): Promise<RetractResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      const ref = this.normalizeFactId(factId);
      const now = new Date();

      // Verify the fact exists and is currently active.
      const [existingRows] = await db.query<any[][]>(
        `SELECT id, status, retractedAt, validFrom FROM type::thing('knowledge_fact', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const existing = (existingRows as any[])?.[0];
      if (!existing) {
        throw new NotFoundException(`Fact ${factId} not found`);
      }
      if (existing.retractedAt) {
        return {
          factId: String(existing.id),
          retractedAt: new Date(existing.retractedAt).toISOString(),
          cascadedFactIds: [],
          revivedFactIds: [],
        };
      }

      const cascaded = await this.cascadeRetract(db, String(existing.id), now, dto.reason);

      await dbMerge(db, `knowledge_fact:${ref.id}`, {
        status: 'retracted',
        retractedAt: now,
        retractedBy: dto.retractedBy.source,
        retractionReason: dto.reason,
        validUntil: existing.validUntil ?? now,
      });

      // Revive the supersede chain. Any fact that was marked
      // superseded by this fact and was NOT separately retracted on
      // its own merits is brought back to status='active' with the
      // pre-supersede validUntil snapshot (priorValidUntil — written
      // by fn::resolve_fact in migration 0021). Predecessors that
      // were explicitly retracted (retractedAt set with a non-
      // 'superseded' reason) keep their state — their hidden-ness
      // had an independent cause.
      const revived = await this.reviveSupersededBy(db, String(existing.id));

      this.logger.log(
        `[knowledge.fact.retracted] companyId=${companyId} factId=${existing.id} cascaded=${cascaded.length} revived=${revived.length}`,
      );

      return {
        factId: String(existing.id),
        retractedAt: now.toISOString(),
        cascadedFactIds: cascaded,
        revivedFactIds: revived,
      };
    });
  }

  /**
   * Revive every fact whose `supersededBy` equals the just-retracted
   * fact AND whose retractionReason is exactly 'superseded' (the
   * sentinel fn::resolve_fact writes when it marks a competitor
   * superseded — distinct from operator-driven retracts which carry
   * a free-text reason). Restores:
   *   status          'superseded' → 'active'
   *   retractedAt     → NONE
   *   retractedBy     → NONE
   *   retractionReason → NONE
   *   supersededBy    → NONE
   *   validUntil      → priorValidUntil
   *   priorValidUntil → NONE
   *
   * Idempotent — running twice on the same retract is a no-op
   * because the first pass already moved status to 'active' and
   * cleared the supersededBy edge.
   */
  private async reviveSupersededBy(
    db: Surreal,
    retractedFactId: string,
  ): Promise<string[]> {
    const rid = this.normalizeFactId(retractedFactId).id;
    const [rows] = await db.query<any[][]>(
      `SELECT id, priorValidUntil FROM knowledge_fact
         WHERE supersededBy = type::thing('knowledge_fact', $rid)
           AND status = 'superseded'
           AND retractionReason = 'superseded'`,
      { rid },
    );
    const candidates = (rows as Array<{ id: unknown; priorValidUntil: unknown }>) ?? [];
    const revived: string[] = [];
    for (const c of candidates) {
      const childIdStr = String(c.id);
      // Use explicit SET …, … = NONE — `MERGE` with JSON `null` does
      // not unset an `option<datetime>` field; SurrealDB needs the
      // literal NONE token to clear it.
      await db.query(
        `UPDATE $id SET
            status = 'active',
            retractedAt = NONE,
            retractedBy = NONE,
            retractionReason = NONE,
            supersededBy = NONE,
            validUntil = $priorValidUntil,
            priorValidUntil = NONE`,
        {
          id: c.id,
          priorValidUntil: c.priorValidUntil ?? undefined,
        },
      );
      revived.push(childIdStr);
    }
    return revived;
  }

  /**
   * Walk derivedFrom edges. Any fact whose derivedFrom contains the retracted
   * fact (and has no other still-active parent) gets cascade-retracted.
   *
   * For 0.1.0 we apply a simpler rule: if any parent is retracted, the child
   * is retracted. Lazy re-validation on retrieval is a 0.2.0 enhancement.
   */
  private async cascadeRetract(
    db: Surreal,
    parentFactId: string,
    now: Date,
    reason: string,
  ): Promise<string[]> {
    const cascaded: string[] = [];
    const stack = [parentFactId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const [childRows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_fact
         WHERE derivedFrom CONTAINS type::thing('knowledge_fact', $cid)
           AND retractedAt IS NONE`,
        { cid: this.normalizeFactId(current).id },
      );
      const children = (childRows as any[]) ?? [];
      for (const child of children) {
        const childIdStr = String(child.id);
        await dbMerge(db, childIdStr, {
          status: 'retracted',
          retractedAt: now,
          retractedBy: 'cascade',
          retractionReason: `parent retracted: ${reason}`,
          validUntil: now,
        });
        cascaded.push(childIdStr);
        stack.push(childIdStr);
      }
    }
    return cascaded;
  }

  /**
   * Accept either `<id>` or `knowledge_fact:<id>` as the URL path parameter.
   */
  private normalizeFactId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_fact:') ? raw.slice('knowledge_fact:'.length) : raw;
    return { id, full: `knowledge_fact:${id}` };
  }
}
