import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../../db/surreal.service';
import { EmbedderService } from '../embedder.service';
import { envFlagEnabled } from '../../common/env-validation';
import { EMBEDDING_SPACE_FIELD } from './embedding-space';

interface FactRowForReindex {
  id: { tb: string; id: { String: string } } | string;
  predicate: string;
  object: string;
}

/** One additional embedding-bearing table the opt-in all-tables sweep can
 *  re-embed. `text` mirrors the WRITE-path projection so a reindex produces
 *  the same vector the ingest/derive path would. */
interface ReindexTableSpec {
  table: string;
  /** The column holding the vector (fixed literal, never caller input). */
  vectorField: string;
  /** Columns the SELECT must fetch to rebuild the embed text. */
  select: string;
  /** Rebuild the embed text from a row; empty string ⇒ skip the row. */
  text: (row: Record<string, unknown>) => string;
}

/**
 * The non-fact tables the sweep covers, each re-embedding from a STORED
 * text column so the projection cannot drift from a separately-maintained
 * copy. Sourced from the confirmed write paths:
 *   - knowledge_entity   — entity-resolver embeds `name: <name>`
 *   - knowledge_predicate— db-mapping.embeddingTextFor: `<id_ws>: <desc>`
 *   - episode            — episode.text (embeddings are derived state, not
 *                          yet backfilled; the != NONE guard makes this a
 *                          safe no-op until they are)
 *   - episode_segment    — segment-composer stores the exact embedded `text`
 *   - strategy_memory    — `<title>\n<situation>` (strategy-memory.service)
 *
 * community_node (summaryEmbedding) and procedural_memory (triggerEmbedding)
 * are intentionally NOT here: their vectors are produced by a summarization
 * / trigger-derive pass, not a plain re-embed, so they are re-stamped by
 * their own write paths, not by this sweep.
 */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const ADDITIONAL_TABLE_SPECS: ReindexTableSpec[] = [
  {
    table: 'knowledge_entity',
    vectorField: 'embedding',
    select: 'id, name, canonicalName, embedding',
    text: (r) => {
      const name = asStr(r.canonicalName) || asStr(r.name);
      return name ? `name: ${name}` : '';
    },
  },
  {
    table: 'knowledge_predicate',
    vectorField: 'embedding',
    select: 'id, predicateId, description, embedding',
    text: (r) => {
      const pid = asStr(r.predicateId);
      return pid ? `${pid.replace(/_/g, ' ')}: ${asStr(r.description)}` : '';
    },
  },
  {
    table: 'episode',
    vectorField: 'embedding',
    select: 'id, text, embedding',
    text: (r) => asStr(r.text),
  },
  {
    table: 'episode_segment',
    vectorField: 'embedding',
    select: 'id, text, embedding',
    text: (r) => asStr(r.text),
  },
  {
    table: 'strategy_memory',
    vectorField: 'embedding',
    select: 'id, title, situation, embedding',
    text: (r) => {
      const title = asStr(r.title);
      const situation = asStr(r.situation);
      return title || situation ? `${title}\n${situation}` : '';
    },
  },
];

/** Per-table row of the opt-in all-tables sweep, surfaced for operator audit. */
export interface TableReindexCount {
  table: string;
  scanned: number;
  updated: number;
}

export interface ReindexTenantResult {
  factsScanned: number;
  factsUpdated: number;
  /** Present ONLY when the all-tables sweep ran; absent on the default
   *  knowledge_fact-only path so the response stays byte-identical. */
  tables?: TableReindexCount[];
}

/** Per-tenant reindex context — the open DB handle, the tenant id (for log
 *  lines), and the space stamp (null ⇒ EMBEDDING_SPACE_TRACKING off). Bundled
 *  so the helpers stay ≤3 params. */
interface ReindexCtx {
  db: Surreal;
  companyId: string;
  spaceId: string | null;
}

/**
 * ReindexEngineService — the per-tenant re-embed engine.
 *
 * Owns the "how to reindex ONE tenant" mechanics (pagination, batched
 * embedMany, row updates) plus the active embedder provider id. The
 * tenant-iteration / orchestration lives in ReindexEmbeddingsService,
 * which delegates here. Splitting the engine out keeps each class's
 * injected-dep list ≤3 and isolates the DB/embedder machinery from the
 * "which tenants" policy.
 *
 * Space-tracking (Tier 2): with EMBEDDING_SPACE_TRACKING on, every rewrite
 * ALSO stamps `embeddingSpaceId` with the active provider's canonical space
 * so the row declares which space its vector lives in. With the flag off
 * (default) NO stamp is written and the DEFAULT reindex covers knowledge_fact
 * ONLY — byte-identical to pre-Tier-2.
 */
@Injectable()
export class ReindexEngineService {
  private readonly logger = new Logger(ReindexEngineService.name);
  private readonly batchSize: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = parseInt(this.config.get<string>('REINDEX_BATCH_SIZE', '200'), 10);
  }

  /**
   * The active embedder provider id, surfaced in the response for
   * operator audit. The stub embedder used in tests doesn't implement
   * cacheStats, so we fall back to 'unknown' instead of crashing.
   */
  providerId(): string {
    return typeof this.embedder.cacheStats === 'function'
      ? this.embedder.cacheStats().provider
      : 'unknown';
  }

  /**
   * Whether to stamp `embeddingSpaceId` on rewrite. Read per-call so an
   * operator flip takes effect without a restart. Off (default) ⇒ the
   * UPDATE clause is exactly the pre-Tier-2 `SET embedding = $embedding`.
   */
  private spaceStampId(): string | null {
    if (!envFlagEnabled(this.config.get<string>('EMBEDDING_SPACE_TRACKING'))) return null;
    return this.embedder.activeSpaceId();
  }

  async reindexTenant(
    companyId: string,
    opts: { dryRun: boolean; remaining: number; allTables?: boolean },
  ): Promise<ReindexTenantResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      const ctx: ReindexCtx = { db, companyId, spaceId: this.spaceStampId() };
      const factResult = await this.reindexKnowledgeFacts(ctx, opts);
      if (opts.allTables !== true) return factResult;

      // Opt-in sweep over the remaining embedding-bearing tables. Each is
      // capped independently by `remaining` (a shared budget would make the
      // per-table numbers depend on iteration order, which is worse for
      // operator reasoning).
      const tables: TableReindexCount[] = [];
      for (const spec of ADDITIONAL_TABLE_SPECS) {
        tables.push(await this.reindexGenericTable(ctx, spec, opts));
      }
      return { ...factResult, tables };
    });
  }

  /**
   * Rewrite one row's vector. Byte-identical to pre-Tier-2 when
   * `ctx.spaceId` is null (EMBEDDING_SPACE_TRACKING off): the UPDATE is
   * `SET <vectorField> = $embedding`, no extra column touched. `vectorField`
   * is a fixed literal, never caller input.
   */
  private async writeVector(
    ctx: ReindexCtx,
    vectorField: string,
    entry: { id: unknown; vector: number[] | undefined },
  ): Promise<void> {
    if (ctx.spaceId) {
      await ctx.db.query(
        `UPDATE $id SET ${vectorField} = $embedding, ${EMBEDDING_SPACE_FIELD} = $space`,
        { id: entry.id, embedding: entry.vector, space: ctx.spaceId },
      );
    } else {
      await ctx.db.query(`UPDATE $id SET ${vectorField} = $embedding`, {
        id: entry.id,
        embedding: entry.vector,
      });
    }
  }

  /**
   * knowledge_fact reindex — the DEFAULT path.
   */
  private async reindexKnowledgeFacts(
    ctx: ReindexCtx,
    opts: { dryRun: boolean; remaining: number },
  ): Promise<{ factsScanned: number; factsUpdated: number }> {
    let offset = 0;
    let factsScanned = 0;
    let factsUpdated = 0;
    const batch = Math.min(this.batchSize, opts.remaining);
    // Paginate until either the tenant is empty or we hit the cap.
    while (factsScanned < opts.remaining) {
      const [rows] = await ctx.db.query<[FactRowForReindex[]]>(
        `SELECT id, predicate, object
            FROM knowledge_fact
            ORDER BY id
            LIMIT $batch START $offset`,
        { batch, offset },
      );
      const page = (rows as FactRowForReindex[]) ?? [];
      if (page.length === 0) break;

      factsScanned += page.length;
      if (!opts.dryRun) {
        // Batch the whole page through one embedMany — the previous
        // per-row embed() loop paid one HTTP round-trip per fact.
        const texts = page.map((row) => `${row.predicate}: ${row.object}`);
        const embeddings = await this.embedPageOrNull(texts, `knowledge_fact ${ctx.companyId}`);
        if (embeddings) {
          const entries = page.map((row, i) => ({ id: row.id, vector: embeddings[i] }));
          factsUpdated += await this.writePage(ctx, 'embedding', entries);
        }
      }
      offset += page.length;
      if (page.length < batch) break;
    }
    return { factsScanned, factsUpdated };
  }

  /**
   * Re-embed one non-fact table (opt-in sweep). Rewrites ONLY rows that
   * ALREADY carry a vector (`WHERE <vectorField> != NONE`) — the sweep MOVES
   * existing embeddings into the active space, it never creates embeddings
   * where the write path left none (so tables whose vectors are unpopulated
   * derived state are a safe no-op). Stamps `embeddingSpaceId` when tracking
   * is on. `vectorField`/`table`/`select` are fixed literals from
   * ADDITIONAL_TABLE_SPECS, never caller input.
   */
  private async reindexGenericTable(
    ctx: ReindexCtx,
    spec: ReindexTableSpec,
    opts: { dryRun: boolean; remaining: number },
  ): Promise<TableReindexCount> {
    let offset = 0;
    let scanned = 0;
    let updated = 0;
    const batch = Math.min(this.batchSize, opts.remaining);
    while (scanned < opts.remaining) {
      const [rows] = await ctx.db.query<[Array<Record<string, unknown>>]>(
        `SELECT ${spec.select}
            FROM ${spec.table}
            WHERE ${spec.vectorField} != NONE
            ORDER BY id
            LIMIT $batch START $offset`,
        { batch, offset },
      );
      const page = (rows as Array<Record<string, unknown>>) ?? [];
      if (page.length === 0) break;
      scanned += page.length;
      if (!opts.dryRun) updated += await this.reindexGenericPage(ctx, spec, page);
      offset += page.length;
      if (page.length < batch) break;
    }
    return { table: spec.table, scanned, updated };
  }

  /** Re-embed + rewrite one page of a non-fact table. Skips rows with no
   *  usable source text so a vector is never overwritten with a zero one. */
  private async reindexGenericPage(
    ctx: ReindexCtx,
    spec: ReindexTableSpec,
    page: Array<Record<string, unknown>>,
  ): Promise<number> {
    const kept: Array<Record<string, unknown>> = [];
    const texts: string[] = [];
    for (const row of page) {
      const t = spec.text(row).trim();
      if (t) {
        kept.push(row);
        texts.push(t);
      }
    }
    if (texts.length === 0) return 0;
    const embeddings = await this.embedPageOrNull(texts, `${spec.table} ${ctx.companyId}`);
    if (!embeddings) return 0;
    const entries = kept.map((row, i) => ({ id: row.id, vector: embeddings[i] }));
    return this.writePage(ctx, spec.vectorField, entries);
  }

  /** Embed a page, logging + swallowing a batch failure (returns null so the
   *  caller advances past the page rather than retry-looping). */
  private async embedPageOrNull(texts: string[], where: string): Promise<number[][] | null> {
    try {
      return await this.embedder.embedMany(texts);
    } catch (e) {
      this.logger.warn(
        `reindex batch embed failed (${where}, page=${texts.length}): ${(e as Error).message}`,
      );
      return null;
    }
  }

  /** Write each row's vector, tolerating a per-row failure. Returns the
   *  number of rows successfully updated. */
  private async writePage(
    ctx: ReindexCtx,
    vectorField: string,
    entries: Array<{ id: unknown; vector: number[] | undefined }>,
  ): Promise<number> {
    let updated = 0;
    for (const entry of entries) {
      try {
        await this.writeVector(ctx, vectorField, entry);
        updated += 1;
      } catch (e) {
        this.logger.warn(
          `reindex ${vectorField} row update failed (${ctx.companyId}): ${(e as Error).message}`,
        );
      }
    }
    return updated;
  }
}
