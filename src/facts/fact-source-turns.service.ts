import { Injectable } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { pinUserScope } from '../auth/user-scope';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { isoString } from '../common/surreal-date';

/** One raw turn a fact was read from, as a reader may see it. */
export interface SourceTurn {
  episodeId: string;
  text: string;
  at: string;
  speaker?: string | undefined;
}

/**
 * The raw turns behind a set of facts, fenced exactly like
 * get_fact_provenance (the shared episode read port: PII, the user pin,
 * scope tags). A turn the caller may not read is simply absent — the fact
 * then has no quotable source.
 *
 * The focus view of search_knowledge (src/mcp/compact-read.ts) reads it
 * to hand back whichever is cheaper per piece of evidence: the facts, or
 * the sentence they came from — so a memory answer never costs more than
 * the raw it was distilled from.
 */
@Injectable()
export class FactSourceTurnsService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
  ) {}

  async turnsOf(p: {
    companyId: string;
    factIds: string[];
    scopes: string[];
    userId?: string | undefined;
  }): Promise<Map<string, SourceTurn[]>> {
    const out = new Map<string, SourceTurn[]>();
    const factIds = [...new Set(p.factIds)].filter((id) => id.startsWith('knowledge_fact:'));
    if (factIds.length === 0) return out;
    return this.surreal.withScopedCompany(p.companyId, p.scopes, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown; eps?: unknown }>]>(
        `SELECT id, source.episodeIds AS eps FROM $ids`,
        { ids: factIds.map((id) => new StringRecordId(id)) },
      );
      const epsByFact = new Map<string, string[]>();
      for (const r of rows ?? []) {
        const eps = Array.isArray(r.eps)
          ? r.eps.map(String).filter((e) => e.startsWith('episode:'))
          : [];
        if (eps.length > 0) epsByFact.set(String(r.id), eps);
      }
      const allEps = [...new Set([...epsByFact.values()].flat())];
      if (allEps.length === 0) return out;
      const turns = await this.episodes.byIds({
        companyId: p.companyId,
        ids: allEps,
        includePii: p.scopes.includes('brain:read_pii'),
        userId: pinUserScope(p.userId),
        db,
      });
      const byId = new Map<string, SourceTurn>(
        turns.map((t): [string, SourceTurn] => [
          String(t.id),
          {
            episodeId: String(t.id),
            text: t.text,
            at: isoString(t.occurredAt),
            ...(t.speaker ? { speaker: t.speaker } : {}),
          },
        ]),
      );
      for (const [factId, eps] of epsByFact) {
        const seen = eps.map((e) => byId.get(e)).filter((t): t is SourceTurn => t !== undefined);
        if (seen.length > 0) out.set(factId, seen);
      }
      return out;
    });
  }
}
