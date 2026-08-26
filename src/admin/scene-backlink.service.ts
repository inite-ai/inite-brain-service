import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { sceneFactBacklinkEnabled } from '../common/scene-flags';
import { SceneVersionService } from './scene-version';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildSupportEdgeBatches } from '../common/support-edges';

/**
 * Scene fact backlinker (Brain v2 PR2, SCENES_FACT_BACKLINK — default
 * off): stamps each knowledge_fact whose grounding turns fall inside a
 * scene with a pointer to that scene — facts become entries into the
 * episodic plane. For every memory_episode of the CURRENT segmenter
 * version it intersects (IN JS — `source` is FLEXIBLE, unindexed) the
 * fact's source.episodeIds strings with the scene's member episode ids,
 * then stamps the matches:
 *
 *   source.memoryEpisodeIds ∪= [scene id]   (array::union — idempotent)
 *   source.sceneLinkVersion  = <EFFECTIVE segmenter version — under
 *   SCENES_VERSION_FINGERPRINT the fingerprinted string, resolved once
 *   per run (SceneVersionService), so the stamp always names the world
 *   that was linked>
 *
 * FLEXIBLE-source ride, no migration. Idempotent and re-runnable after a
 * re-segmentation (scene record ids are deterministic per (conversation,
 * version, index), so a rebuild re-links onto the same identities; the
 * GDPR cascades may leave stale pointer strings behind — a re-run is the
 * documented repair, see entity-forget.service.ts).
 *
 * SERVING STAYS BYTE-IDENTICAL: nothing reads source.memoryEpisodeIds.
 * The keys are merely VISIBLE wherever `source` is already returned
 * verbatim (facts read/provenance API) — additive payload, no behavior.
 *
 * UPDATE targets an explicit id list (`WHERE id INSIDE $factIds`) —
 * primary-key addressed, immune by construction to the 3.2.4 planner bug
 * class where a mutation filtered on a compound-index-covered field
 * silently no-ops (scene-composer swap comment; PR #372).
 */

/** Cap on fact ids per UPDATE statement (bounded query payloads). */
const FACTS_PER_UPDATE = 200;

/** Minimal fact head for the intersection: id + grounding turn strings. */
export interface BacklinkFactHead {
  id: unknown;
  /** source.episodeIds as selected — unknown until validated in JS. */
  episodeIds?: unknown;
}

/**
 * Pure: the fact ids whose source.episodeIds intersect the scene's member
 * episode ids. Non-array / non-string entries are ignored (FLEXIBLE
 * `source` guarantees nothing about the shape).
 */
export function matchFactsToScene(
  facts: readonly BacklinkFactHead[],
  memberEpisodeIds: ReadonlySet<string>,
): unknown[] {
  const out: unknown[] = [];
  for (const fact of facts) {
    if (!Array.isArray(fact.episodeIds)) continue;
    if (fact.episodeIds.some((e) => typeof e === 'string' && memberEpisodeIds.has(e))) {
      out.push(fact.id);
    }
  }
  return out;
}

export interface SceneBacklinkResult {
  scenes: number;
  factsLinked: number;
}

@Injectable()
export class SceneBacklinkService {
  private readonly logger = new Logger(SceneBacklinkService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly versions: SceneVersionService,
  ) {}

  async run(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<SceneBacklinkResult> {
    const result: SceneBacklinkResult = { scenes: 0, factsLinked: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not stamp fact rows past a disabled flag.
    if (!sceneFactBacklinkEnabled()) return result;
    // Effective version resolved ONCE per run: the scene selection AND the
    // sceneLinkVersion stamp both follow the composer's stamps. CONTAINS
    // filters below stay — backlink only ADDS pointers, never deletes.
    const { version } = this.versions.resolve();
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[Array<{ id: unknown; conversationIds: string[] }>]>(
        `SELECT id, conversationIds FROM memory_episode WHERE segmenterVersion = $v` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      // One fact read per conversation, shared across its scenes. The
      // `source.conversationId = $conv` filter walks the table (FLEXIBLE
      // source has no index) — acceptable for a batch admin pass, and the
      // cache keeps it to one walk per conversation per run.
      const factCache = new Map<string, BacklinkFactHead[]>();
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        const [members] = await db.query<[Array<{ out: unknown }>]>(
          `SELECT out FROM memory_episode_member WHERE in = $scene`,
          { scene: scene.id },
        );
        const memberEpisodeIds = new Set((members ?? []).map((m) => String(m.out)));
        if (memberEpisodeIds.size === 0) continue;

        // Dedupe across the (today always length-1) conversation list.
        const matched = new Map<string, unknown>();
        for (const conversationId of scene.conversationIds) {
          let facts = factCache.get(conversationId);
          if (!facts) {
            const [rows] = await db.query<[BacklinkFactHead[]]>(
              `SELECT id, source.episodeIds AS episodeIds FROM knowledge_fact
                WHERE source.conversationId = $conv`,
              { conv: conversationId },
            );
            facts = rows ?? [];
            factCache.set(conversationId, facts);
          }
          for (const id of matchFactsToScene(facts, memberEpisodeIds)) {
            matched.set(String(id), id);
          }
        }
        if (matched.size === 0) continue;

        const factIds = [...matched.values()];
        for (let i = 0; i < factIds.length; i += FACTS_PER_UPDATE) {
          await db.query(
            `UPDATE knowledge_fact SET
               source.memoryEpisodeIds = array::union(source.memoryEpisodeIds ?? [], [$sceneId]),
               source.sceneLinkVersion = $v
             WHERE id INSIDE $factIds`,
            {
              sceneId: String(scene.id),
              v: version,
              factIds: factIds.slice(i, i + FACTS_PER_UPDATE),
            },
          );
        }
        result.factsLinked += factIds.length;

        // Typed support graph (PROVENANCE_SUPPORT_EDGES, default off):
        // fact-supported_by->scene edges IN ADDITION to the string
        // stamps above (stamps are existing default-on behavior; their
        // removal is a separate cleanup once the typed reader is
        // proven). Replay-idempotent: INSERT RELATION IGNORE over
        // UNIQUE(in, out, kind) — a re-segmentation re-run lands on the
        // same deterministic scene ids and inserts nothing new. Off ⇒
        // this whole block is skipped and the query sequence above is
        // byte-identical. writerVersion follows the SAME effective
        // version as the sceneLinkVersion stamp above (SceneVersionService,
        // resolved once per run) — under SCENES_VERSION_FINGERPRINT the
        // edge names the fingerprinted world that was linked; flag off ⇒
        // the literal SEGMENTER_VERSION, byte-identical to the pre-#386
        // stamp.
        if (supportEdgesEnabled()) {
          const { batches, skipped } = buildSupportEdgeBatches({
            kind: 'supported_by',
            writer: 'scene_backlink',
            writerVersion: version,
            pairs: factIds.map((id) => ({ in: String(id), out: String(scene.id) })),
          });
          if (skipped > 0) {
            this.logger.warn(`scene backlink: ${skipped} malformed support-edge pair(s) skipped`);
          }
          for (const batch of batches) {
            await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
              rows: batch.map((r) => ({
                ...r,
                in: new StringRecordId(r.in),
                out: new StringRecordId(r.out),
              })),
            });
          }
        }
      }
    });
    this.logger.log(
      `scene backlink pass: ${result.factsLinked} fact(s) linked over ${result.scenes} scene(s)`,
    );
    return result;
  }
}
