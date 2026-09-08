import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EMBEDDING_SPACE_FIELD } from '../ai/embedder/embedding-space';
import { envFlagEnabled } from '../common/env-validation';
import { sceneGistEmbeddingEnabled } from '../common/scene-flags';
import { SceneVersionService } from './scene-version';

/**
 * Scene gist encoder pass (Brain v2 PR3, SCENES_GIST_EMBEDDING — default
 * off): the PRODUCER the 0106 `gistEmbedding` column never had.
 *
 * THE HOLE THIS FILLS. 0106 defined the column, the composer's header
 * promised "the PR2 encoder pass backfills it", and PR2 shipped without
 * one. Both downstream consumers were then built around the absence:
 *   - the reindex engine registers memory_episode/gistEmbedding but its
 *     sweep runs `WHERE gistEmbedding != NONE` — it MOVES vectors between
 *     embedding spaces, it never creates them, so it was a documented
 *     no-op for scenes ("unpopulated derived state");
 *   - the scene serving lane (RETRIEVAL_SCENE_LANE) shipped BM25-only
 *     because "a dense leg would be write-dead for the default world".
 * This pass is the missing write side; the lane's dense leg is the read
 * side it unblocks.
 *
 * WHICH TEXT — `gist`, NOT `enrichedGist`. There is exactly ONE canonical
 * gist TEXT column on a scene and the composer is its only writer: `gist`
 * is immutable post-compose (Drift-3b), the LLM enricher writes its
 * abstractive revision to the SIBLING `enrichedGist` and never touches
 * `gist`. `gist` is also the column the 0106 `scene_gist_search` FULLTEXT
 * index covers, the column the lane renders, and the column the reindex
 * engine already declares as this table's embed source
 * (ADDITIONAL_TABLE_SPECS). Embedding anything else would put the vector
 * out of step with the BM25 leg AND have it silently replaced by the first
 * space-migration sweep. So this ONE seam covers BOTH gist kinds — the
 * deterministic world and the LLM-enriched world alike — which is exactly
 * why the pass lives here (post-swap, composer-side) rather than inside
 * the enricher's UPDATE, which would cover neither.
 *
 * SPACE STAMP — the fact-side convention, verbatim. `embeddingSpaceId` is
 * written ONLY under EMBEDDING_SPACE_TRACKING and always TOGETHER with the
 * vector (the reindex engine's `spaceStampId` / `writeVector` idiom): a
 * NONE column means "the current provider's space" (embedding-space.ts),
 * so with tracking off the row is exactly what a knowledge_fact row looks
 * like, and with it on the reindex/space-migration machinery treats scenes
 * like every other embedded surface.
 *
 * IDEMPOTENT + BOUNDED. Only scenes of the CURRENT effective segmenter
 * world (SceneVersionService, resolved ONCE per run — the Drift-3
 * contract) that carry NO vector are selected, at most
 * SCENE_EMBED_MAX_PER_RUN of them, embedded in ONE batch. A re-run after a
 * complete pass selects nothing and spends nothing; a partial run drains
 * over successive runs (the nightly-maintenance idiom). Re-embedding rows
 * that ALREADY carry a vector is deliberately NOT this pass's job — that
 * is the reindex sweep's, which owns space migration.
 *
 * DEGRADE, NEVER FAIL. The pass runs AFTER the composer's atomic swap, so
 * it must never retract a landed result: an embed batch failure logs a
 * warning and reports `failed`, a per-row write failure is counted and
 * skipped, and the caller's compose still succeeds.
 *
 * WRITE SURFACE: `gistEmbedding` (+ the space stamp) on memory_episode,
 * by BOUND-ID UPDATE — primary-key addressed, immune by construction to
 * the SurrealDB 3.2.4 secondary-index planner bug the 0093 header
 * documents (a WHERE over an indexed field can silently match nothing on
 * a DELETE/UPDATE).
 */

/**
 * Scenes embedded per run (design constant, the SCENE_LANE_TOP_K idiom —
 * deliberately NOT an env knob until the pass is measured). The bound that
 * matters: ONE embedMany batch per run, so a first-time backfill of a
 * large tenant costs a bounded number of vectors per invocation and drains
 * across runs instead of fanning out unboundedly inside one compose.
 */
export const SCENE_EMBED_MAX_PER_RUN = 200;

/** Embedded gist text cap — a belt against a runaway gist, not a budget. */
const GIST_EMBED_MAX_CHARS = 4000;

export interface SceneGistEmbedResult {
  /** Vector-less scenes of the current world this run selected. */
  scenes: number;
  /** Scenes whose vector actually landed. */
  embedded: number;
  /** Selected but unusable (blank gist) — never embedded, never written. */
  skipped: number;
  /** Embed-batch or row-write failures (soft: the run still succeeds). */
  failed: number;
}

/** Head row of a scene awaiting its gist vector. */
interface SceneGistRow {
  id: unknown;
  gist?: unknown;
}

@Injectable()
export class SceneGistEmbeddingService {
  private readonly logger = new Logger(SceneGistEmbeddingService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedding: FactEmbeddingService,
    private readonly versions: SceneVersionService,
  ) {}

  /**
   * Embed the gists of vector-less scenes in the current effective world
   * (optionally one conversation's). Never throws.
   */
  async run(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<SceneGistEmbedResult> {
    const result: SceneGistEmbedResult = { scenes: 0, embedded: 0, skipped: 0, failed: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not spend embedding calls past a disabled
    // flag. Checked FIRST — off means the embedder is not so much as
    // touched and no query is issued.
    if (!sceneGistEmbeddingEnabled()) return result;
    const { version } = this.versions.resolve();
    // The space stamp is resolved ONCE per run, before any write, exactly
    // like the reindex engine resolves it once per tenant.
    const spaceId = this.spaceStampId();
    await this.surreal.withCompany(companyId, async (db) => {
      // Plain WHERE SELECT over indexed fields — safe on 3.2.4 (only
      // DELETE/UPDATE trip the planner bug; see the composer's swap note).
      const convClause =
        opts.conversationId !== undefined ? ' AND conversationIds CONTAINS $conv' : '';
      const [rows] = await db.query<[SceneGistRow[]]>(
        `SELECT id, gist FROM memory_episode
            WHERE segmenterVersion = $v AND gistEmbedding IS NONE${convClause}
            ORDER BY id
            LIMIT $cap`,
        {
          v: version,
          cap: SCENE_EMBED_MAX_PER_RUN,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      const page = rows ?? [];
      result.scenes = page.length;
      if (page.length === 0) return;

      // A blank gist has nothing to encode — never embed it, so a zero
      // vector can never enter the space (the reindex sweep's rule).
      const kept: Array<{ id: unknown; text: string }> = [];
      for (const row of page) {
        const text = typeof row.gist === 'string' ? row.gist.trim() : '';
        if (text === '') {
          result.skipped += 1;
          continue;
        }
        kept.push({ id: row.id, text: text.slice(0, GIST_EMBED_MAX_CHARS) });
      }
      if (kept.length === 0) return;

      // ONE batch for the whole run — the paid step, bounded by the cap.
      let vectors: number[][];
      try {
        vectors = await this.embedding.embedMany(kept.map((k) => k.text));
      } catch (e) {
        result.failed += kept.length;
        this.logger.warn(
          `scene gist embed batch failed (companyId=${companyId}, scenes=${kept.length}): ` +
            `${(e as Error).message} — scenes keep no vector`,
        );
        return;
      }
      for (const [i, entry] of kept.entries()) {
        const vector = vectors[i];
        if (!Array.isArray(vector) || vector.length === 0) {
          result.failed += 1;
          continue;
        }
        try {
          await this.writeVector(db, { id: entry.id, embedding: vector, spaceId });
          result.embedded += 1;
        } catch (e) {
          result.failed += 1;
          this.logger.warn(
            `scene gist vector write failed for ${String(entry.id)}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  /**
   * Whether to stamp `embeddingSpaceId` alongside the vector — the reindex
   * engine's rule, read per-call so an operator flip takes effect without a
   * restart. Off (default) ⇒ the UPDATE is exactly
   * `SET gistEmbedding = $embedding`, and the NONE space column means "the
   * current provider's space" (the legacy/implicit space).
   */
  private spaceStampId(): string | null {
    if (!envFlagEnabled(process.env.EMBEDDING_SPACE_TRACKING)) return null;
    return this.embedding.activeSpaceId();
  }

  /**
   * One scene's vector, by BOUND ID — primary-key addressed, so the 3.2.4
   * secondary-index planner bug cannot silently no-op it. Vector and space
   * id are written TOGETHER or not at all (the 0101 idiom: a vector whose
   * space is unknown cannot be compared to anything).
   */
  private async writeVector(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    entry: { id: unknown; embedding: number[]; spaceId: string | null },
  ): Promise<void> {
    const { id, embedding, spaceId } = entry;
    if (spaceId === null) {
      await db.query(`UPDATE $id SET gistEmbedding = $embedding`, { id, embedding });
      return;
    }
    await db.query(`UPDATE $id SET gistEmbedding = $embedding, ${EMBEDDING_SPACE_FIELD} = $space`, {
      id,
      embedding,
      space: spaceId,
    });
  }
}
