import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import Surreal from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { RetractFactDto } from './dto/retract.dto';

export interface RetractResult {
  factId: string;
  retractedAt: string;
  cascadedFactIds: string[];
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
        };
      }

      const cascaded = await this.cascadeRetract(db, String(existing.id), now, dto.reason);

      await db.merge(`knowledge_fact:${ref.id}` as any, {
        status: 'retracted',
        retractedAt: now,
        retractedBy: dto.retractedBy.source,
        retractionReason: dto.reason,
        validUntil: existing.validUntil ?? now,
      });

      this.logger.log(
        `[knowledge.fact.retracted] companyId=${companyId} factId=${existing.id} cascaded=${cascaded.length}`,
      );

      return {
        factId: String(existing.id),
        retractedAt: now.toISOString(),
        cascadedFactIds: cascaded,
      };
    });
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
        await db.merge(child.id, {
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
