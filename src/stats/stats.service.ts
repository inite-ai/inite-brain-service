import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';

export interface MemoryStats {
  entities: number;
  factsActive: number;
  factsCompeting: number;
  factsRetracted: number;
  communities: number;
  /** Facts recorded (learned) in the last 7 days. */
  factsLast7d: number;
  asOf: string;
}

/**
 * StatsService — cheap per-company memory counts for the end-user
 * "Usage" surface. One batched round-trip of COUNT aggregates, run on a
 * scope-bound connection so PII permissions still apply.
 */
@Injectable()
export class StatsService {
  constructor(private readonly surreal: SurrealService) {}

  async overview(
    companyId: string,
    scopes: readonly string[],
  ): Promise<MemoryStats> {
    const nowMs = Date.now();
    const weekAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const sql = `
        SELECT count() AS c FROM knowledge_entity GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'active' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'competing' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'retracted' GROUP ALL;
        SELECT count() AS c FROM community_node GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE recordedAt > type::datetime($weekAgoIso) GROUP ALL;
      `;
      const res = (await db.query<unknown[]>(sql, { weekAgoIso })) as unknown[];
      return {
        entities: countOf(res[0]),
        factsActive: countOf(res[1]),
        factsCompeting: countOf(res[2]),
        factsRetracted: countOf(res[3]),
        communities: countOf(res[4]),
        factsLast7d: countOf(res[5]),
        asOf: new Date(nowMs).toISOString(),
      };
    });
  }
}

function countOf(stmtResult: unknown): number {
  if (!Array.isArray(stmtResult) || stmtResult.length === 0) return 0;
  const first = stmtResult[0] as { c?: unknown };
  return typeof first?.c === 'number' ? first.c : 0;
}
