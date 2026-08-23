import { Injectable, Optional } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { BrainScope } from '../auth/api-key.types';
import { CODE_MEMORY_PACK, codeMemoryKindOf } from '../ai/domain-packs';
import { makeRowPolicyFilter, type PolicyFilterableRow } from '../policy/row-filter';

export interface RecalledDecision {
  anchor: string;
  kind: string;
  text: string;
  score: number;
  validFrom: string;
}

/** A code-memory fact row as read by recall (extends the row-policy shape). */
interface RecallRow extends PolicyFilterableRow {
  object: unknown;
  validFrom?: string | Date | null;
  refs?: Record<string, string> | null;
  score?: unknown;
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
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
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

    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      // retractedAt IS NONE + the bitemporal validity window mirror
      // /v1/search's default-now filters (search/internals/where-builder.ts):
      // without them an invalidated anchor's facts (retractedAt set but
      // status left 'active' by older writes) and future-dated decisions
      // would surface in recall while every other read path hides them.
      const rows = await queryRows<RecallRow>(
        db,
        `SELECT
             predicate,
             object,
             validFrom,
             source,
             trustSnapshot,
             corroboration,
             entityId.externalRefs AS refs,
             vector::similarity::cosine(embedding, $embedding) AS score
           FROM knowledge_fact
           WHERE predicate >= $prefix AND predicate < $prefixEnd
             AND status = 'active'
             AND retractedAt IS NONE
             AND embedding != NONE
             AND validFrom <= time::now()
             AND (validUntil IS NONE OR validUntil > time::now())
           ORDER BY score DESC
           LIMIT $limit`,
        {
          embedding,
          // Half-open range instead of string::starts_with: a
          // function-wrapped predicate can't use fact_predicate_idx,
          // so every recall was a full scan computing cosine per row.
          // U+FFFF upper-bounds the prefix range.
          prefix: this.prefix,
          prefixEnd: `${this.prefix}￿`,
          limit,
        },
      );
      // Scope + ABAC row gate — code_memory__* predicates are
      // piiClass none today, but per-key source rules (e.g. deny a
      // recorder) must still apply here like on every read surface.
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.scopes,
        surface: 'recall_decisions',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(opts.companyId),
      });
      const visible = rows.filter((r) => rowPolicy.filter(r));
      rowPolicy.finish();
      return visible.map((r) => ({
        anchor: anchorOf(r.refs),
        kind: codeMemoryKindOf(String(r.predicate)),
        text: String(r.object),
        score: typeof r.score === 'number' ? r.score : 0,
        validFrom: r.validFrom ? new Date(r.validFrom).toISOString() : '',
      }));
    });
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
