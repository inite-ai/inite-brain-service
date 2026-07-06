import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { BrainScope } from '../auth/api-key.types';
import { CODE_MEMORY_PACK, codeMemoryKindOf } from '../ai/domain-packs';

export interface RecalledDecision {
  anchor: string;
  kind: string;
  text: string;
  score: number;
  validFrom: string;
}

/**
 * Code-memory-aware semantic retrieval (Phase 3b, docs/roadmap/code-memory-domain.md).
 *
 * The general entity-centric search does NOT surface code anchors by NL topic —
 * their canonicalName is a path string, not natural language, so a topic query
 * returns nothing (verified in the Phase 3 eval). This service is the dedicated
 * retrieval leg: a direct cosine search over the `code_memory__*` facts' own
 * embeddings, returning the matching decisions/rationale/invariants/gotchas with
 * their code anchors. Answers "why do we do X?" across the codebase, vs `why`
 * which reads one known anchor.
 */
@Injectable()
export class CodeMemorySearchService {
  private readonly prefix = `${CODE_MEMORY_PACK.id}__`;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async recall(opts: {
    companyId: string;
    query: string;
    limit?: number;
    scopes: BrainScope[];
  }): Promise<RecalledDecision[]> {
    const q = (opts.query ?? '').trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const embedding = await this.embedder.embed(q);

    return this.surreal.withScopedCompany(
      opts.companyId,
      opts.scopes,
      async (db) => {
        const [rows] = await db.query<[any[]]>(
          `SELECT
             predicate,
             object,
             validFrom,
             entityId.externalRefs AS refs,
             vector::similarity::cosine(embedding, $embedding) AS score
           FROM knowledge_fact
           WHERE string::starts_with(predicate, $prefix)
             AND status = 'active'
             AND embedding != NONE
           ORDER BY score DESC
           LIMIT $limit`,
          { embedding, prefix: this.prefix, limit },
        );
        return ((rows as any[]) ?? []).map((r) => ({
          anchor: anchorOf(r.refs),
          kind: codeMemoryKindOf(String(r.predicate)),
          text: String(r.object),
          score: typeof r.score === 'number' ? r.score : 0,
          validFrom: r.validFrom ? new Date(r.validFrom).toISOString() : '',
        }));
      },
    );
  }
}

/** Pull the original code-anchor string out of an entity's externalRefs map
 *  (the value under the `code__…` key the ingest side wrote). */
function anchorOf(refs: Record<string, string> | undefined | null): string {
  if (!refs) return '';
  for (const [k, v] of Object.entries(refs)) {
    if (k.startsWith('code__')) return String(v);
  }
  return '';
}
