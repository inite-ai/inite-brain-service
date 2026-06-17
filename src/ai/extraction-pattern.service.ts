import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';

/**
 * Per-tenant learned cache of (clauseText → emitted facts + edges).
 *
 * Architecture matches the chat router's CollapsePatternService
 * (Sprint 3): empty at bootstrap, fills as the LLM emits facts per
 * clause, operator-reviewable per tenant. No hardcoded seed list.
 *
 * Per-clause granularity is the differentiator vs the whole-text
 * ExtractorCacheService (Sprint E1) — two ingest payloads with
 * different overall text but a shared clause both replay from this
 * cache. In production traffic recurring assertions like "X is the
 * CTO at Y" or "X joined Y as Z" hit the cache after the first
 * observation.
 *
 * Sprint E7 (skip gate) consumes this service to decide when the
 * entire LLM call can be skipped. Today (Sprint E6) the service
 * only records observations — consumption is layered in next.
 */

export interface CachedFactTemplate {
  predicate: string;
  valueSpan: string;
  confidence: number;
}

export interface CachedEdgeTemplate {
  kind: string;
  /** Relative entity position within the clause. */
  fromEntityIndex: number;
  toEntityIndex: number;
  confidence: number;
}

export interface ExtractionPatternEntry {
  clauseText: string;
  facts: CachedFactTemplate[];
  edges: CachedEdgeTemplate[];
}

const SNAPSHOT_TTL_MS = 60_000;

@Injectable()
export class ExtractionPatternService {
  private readonly logger = new Logger(ExtractionPatternService.name);
  private readonly snapshotCache = new Map<
    string,
    { entries: Map<string, ExtractionPatternEntry>; loadedAt: number }
  >();

  constructor(private readonly surreal: SurrealService) {}

  /** Lowercase + NFC the clause text for natural-key matching. */
  private normalise(clauseText: string): string {
    return clauseText.trim().normalize('NFC').toLowerCase();
  }

  async getSnapshot(
    companyId: string,
  ): Promise<Map<string, ExtractionPatternEntry>> {
    const cached = this.snapshotCache.get(companyId);
    if (cached && Date.now() - cached.loadedAt < SNAPSHOT_TTL_MS) {
      return cached.entries;
    }
    const fresh = await this.loadFresh(companyId);
    this.snapshotCache.set(companyId, {
      entries: fresh,
      loadedAt: Date.now(),
    });
    return fresh;
  }

  async lookup(
    companyId: string,
    clauseText: string,
  ): Promise<ExtractionPatternEntry | undefined> {
    const snap = await this.getSnapshot(companyId);
    return snap.get(this.normalise(clauseText));
  }

  /**
   * Persist (or bump sourceCount on) the patterns observed in this
   * extraction. Idempotent upsert keyed by normalised clauseText.
   * Failure does NOT block the caller — the cache stays cold for
   * that clause and the next extraction triggers another LLM pass.
   */
  async record(
    companyId: string,
    entries: ExtractionPatternEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.surreal.withCompany(companyId, async (db) => {
      for (const e of entries) {
        const key = this.normalise(e.clauseText);
        if (key.length === 0) continue;
        try {
          await db.query(
            `UPSERT extraction_pattern
               SET clauseText = $key,
                   facts = $facts,
                   edges = $edges,
                   updatedAt = time::now(),
                   lastUsedAt = time::now()
               WHERE clauseText = $key`,
            { key, facts: e.facts, edges: e.edges },
          );
          await db.query(
            `UPDATE extraction_pattern
               SET sourceCount = sourceCount + 1, updatedAt = time::now()
             WHERE clauseText = $key`,
            { key },
          );
        } catch (err) {
          this.logger.warn(
            `record(${companyId}): failed to upsert pattern for "${key.slice(0, 60)}": ${(err as Error).message}`,
          );
        }
      }
    });
    this.invalidate(companyId);
  }

  invalidate(companyId: string): void {
    this.snapshotCache.delete(companyId);
  }

  private async loadFresh(
    companyId: string,
  ): Promise<Map<string, ExtractionPatternEntry>> {
    return this.surreal.withCompany(companyId, async (db) => {
      try {
        const [rows] = await db.query<
          [
            Array<{
              clauseText: string;
              facts: CachedFactTemplate[];
              edges: CachedEdgeTemplate[];
            }>,
          ]
        >(`SELECT clauseText, facts, edges FROM extraction_pattern`);
        const out = new Map<string, ExtractionPatternEntry>();
        for (const r of (rows as Array<{
          clauseText: string;
          facts: CachedFactTemplate[];
          edges: CachedEdgeTemplate[];
        }>) ?? []) {
          if (typeof r.clauseText !== 'string') continue;
          out.set(this.normalise(r.clauseText), {
            clauseText: r.clauseText,
            facts: Array.isArray(r.facts) ? r.facts : [],
            edges: Array.isArray(r.edges) ? r.edges : [],
          });
        }
        return out;
      } catch (e) {
        this.logger.warn(
          `loadFresh(${companyId}) failed: ${(e as Error).message}; using empty snapshot`,
        );
        return new Map();
      }
    });
  }
}
