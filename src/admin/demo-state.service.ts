import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';

/**
 * DemoStateService — the DB-direct slice of the live-demo sandbox:
 * accumulated-state counts, full reset, and the known-entity-name lookup
 * the chat router uses for canonicalisation. Extracted from
 * AdminDemoController so the controller holds no `src/db` import (layer
 * purity) and keeps ≤3 deps.
 */
@Injectable()
export class DemoStateService {
  private readonly logger = new Logger(DemoStateService.name);

  constructor(private readonly surreal: SurrealService) {}

  async state(
    tenant: string,
  ): Promise<{ entities: number; facts: number; lastIngestAt: string | null }> {
    try {
      return await this.surreal.withCompany(tenant, async (db) => {
        const [eRows, fRows, lastRows] = (await db.query<
          [
            Array<{ c: number }>,
            Array<{ c: number }>,
            Array<{ recordedAt?: string }>,
          ]
        >(
          `SELECT count() AS c FROM knowledge_entity WHERE mergedInto IS NONE GROUP ALL;
           SELECT count() AS c FROM knowledge_fact WHERE retractedAt IS NONE GROUP ALL;
           SELECT recordedAt FROM knowledge_fact ORDER BY recordedAt DESC LIMIT 1;`,
        )) as any;
        const entities = (eRows as Array<{ c: number }>)?.[0]?.c ?? 0;
        const facts = (fRows as Array<{ c: number }>)?.[0]?.c ?? 0;
        const lastAt = (lastRows as Array<{ recordedAt?: string }>)?.[0]
          ?.recordedAt;
        return { entities, facts, lastIngestAt: lastAt ?? null };
      });
    } catch {
      // Tenant doesn't exist yet — that's a clean state, not an error.
      return { entities: 0, facts: 0, lastIngestAt: null };
    }
  }

  async reset(
    tenant: string,
  ): Promise<{ dropped: boolean; reason?: string }> {
    try {
      await this.surreal.dropCompanyDatabase(tenant);
    } catch (e) {
      // Reset is idempotent — a missing DB is a success state.
      return { dropped: false, reason: (e as Error).message };
    }
    return { dropped: true };
  }

  async fetchKnownEntityNames(tenant: string): Promise<string[]> {
    // Top 25 canonical names from the demo tenant — bounded so the
    // router prompt doesn't bloat. Best-effort: if the tenant is empty
    // / the read fails, return [] and the router just won't
    // canonicalise this turn.
    try {
      return await this.surreal.withCompany(tenant, async (db) => {
        const [rows] = await db.query<[Array<{ canonicalName: string }>]>(
          `SELECT canonicalName FROM knowledge_entity ` +
            `WHERE mergedInto IS NONE AND canonicalName IS NOT NONE ` +
            `LIMIT 25`,
        );
        return ((rows as Array<{ canonicalName: string }>) ?? [])
          .map((r) => r.canonicalName)
          .filter(Boolean);
      });
    } catch (e) {
      this.logger.debug(
        `fetchKnownEntityNames(${tenant}) returned empty: ${(e as Error).message ?? e}`,
      );
      return [];
    }
  }
}
