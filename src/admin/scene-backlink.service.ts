import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { sceneFactBacklinkEnabled } from '../common/scene-flags';
import { SceneVersionService } from './scene-version';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildSupportEdgeBatches } from '../common/support-edges';

/**
 * Scene fact backlinker (SCENES_FACT_BACKLINK, default off). Contract:
 * after a run, for every fact in scope, `source.memoryEpisodeIds` is
 * EXACTLY the set of scenes of the effective segmenter version whose
 * live membership intersects the fact's `source.episodeIds`, and
 * `source.sceneLinkVersion` names that version. A run is a reconcile,
 * not an accumulation: the pointer set is recomputed from
 * memory_episode_member and SET, so pointers to scenes that were purged
 * (GDPR cascades, the version purge verb), rebuilt with a different
 * membership, or that belong to another version are removed; a stamped
 * fact left without a scene keeps an empty array under the reconciled
 * version, and a fact never stamped is never touched. Scope is one
 * conversation when given; otherwise every conversation of the world
 * PLUS every conversation whose facts still carry a stamp — so a
 * conversation that lost all its scenes is repaired too. The stamp is
 * the CURRENT view; per-version history is the memory_support
 * `supported_by` edges (writerVersion-stamped, only ever added here,
 * erased by the GDPR cascades with their scene). Nothing on the serving
 * path reads either key. Every UPDATE is primary-key addressed
 * (`WHERE id INSIDE $factIds`) — outside the 3.2.4 compound-index
 * planner no-op class (PR #372).
 */

/** Cap on fact ids per UPDATE statement (bounded query payloads). */
const FACTS_PER_UPDATE = 200;

/** Minimal fact head for the intersection: id + grounding turn strings. */
export interface BacklinkFactHead {
  id: unknown;
  /** source.episodeIds as selected — unknown until validated in JS. */
  episodeIds?: unknown;
}

/** Fact head plus the stamp as stored — both unknown until validated in JS. */
export interface ReconcileFactHead extends BacklinkFactHead {
  memoryEpisodeIds?: unknown;
  sceneLinkVersion?: unknown;
}

/** One scene of the effective world with its live member episode ids. */
export interface BacklinkSceneHead {
  id: string;
  memberEpisodeIds: ReadonlySet<string>;
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

/** One UPDATE group: every fact id gets exactly this pointer set. */
export interface BacklinkWrite {
  sceneIds: string[];
  factIds: unknown[];
}

export interface BacklinkReconcilePlan {
  /** Facts with at least one current pointer, with their scene ids. */
  linked: Array<{ factId: unknown; sceneIds: string[] }>;
  /** Stamp writes, grouped by pointer set; only facts whose stamp differs. */
  writes: BacklinkWrite[];
  /** Stored pointer strings that name no current scene of the fact. */
  stalePointersRemoved: number;
}

/**
 * Pure: the reconcile plan for one conversation. `scenes` are the
 * effective world's scenes of that conversation; a fact's current set is
 * the (sorted) ids of those whose membership intersects its grounding.
 * A fact is written when its stored stamp is not exactly that set under
 * `version`; a fact with no current scene and no stamp is left alone.
 */
export function planBacklinkReconcile(
  facts: readonly ReconcileFactHead[],
  scenes: readonly BacklinkSceneHead[],
  version: string,
): BacklinkReconcilePlan {
  const plan: BacklinkReconcilePlan = { linked: [], writes: [], stalePointersRemoved: 0 };
  const groups = new Map<string, BacklinkWrite>();
  for (const fact of facts) {
    const current = scenes
      .filter((s) => matchFactsToScene([fact], s.memberEpisodeIds).length > 0)
      .map((s) => s.id)
      .sort();
    const stamped = fact.memoryEpisodeIds !== undefined && fact.memoryEpisodeIds !== null;
    if (current.length === 0 && !stamped) continue;
    if (current.length > 0) plan.linked.push({ factId: fact.id, sceneIds: current });

    const storedRaw: unknown[] | null = Array.isArray(fact.memoryEpisodeIds)
      ? fact.memoryEpisodeIds
      : null;
    const stored = storedRaw?.filter((e): e is string => typeof e === 'string') ?? [];
    const currentSet = new Set(current);
    plan.stalePointersRemoved += stored.filter((id) => !currentSet.has(id)).length;
    // Unchanged only when the stored array is exactly the current set
    // (all strings, same length, same members) under the same version.
    const storedSet = new Set(stored);
    const unchanged =
      storedRaw !== null &&
      stored.length === storedRaw.length &&
      stored.length === current.length &&
      current.every((id) => storedSet.has(id)) &&
      fact.sceneLinkVersion === version;
    if (unchanged) continue;

    const key = current.join('\n');
    let group = groups.get(key);
    if (!group) {
      group = { sceneIds: current, factIds: [] };
      groups.set(key, group);
      plan.writes.push(group);
    }
    group.factIds.push(fact.id);
  }
  return plan;
}

export interface SceneBacklinkResult {
  scenes: number;
  /** Facts that point into the effective world after the run. */
  factsLinked: number;
  /** Pointer strings removed because they named no current scene. */
  stalePointersRemoved: number;
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
    const result: SceneBacklinkResult = { scenes: 0, factsLinked: 0, stalePointersRemoved: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not touch fact rows past a disabled flag.
    if (!sceneFactBacklinkEnabled()) return result;
    // Effective version resolved ONCE per run: the scene selection and
    // the sceneLinkVersion stamp name the same world.
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
      // The world's scenes with live membership, grouped by conversation.
      const scenesByConversation = new Map<string, BacklinkSceneHead[]>();
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        const [members] = await db.query<[Array<{ out: unknown }>]>(
          `SELECT out FROM memory_episode_member WHERE in = $scene`,
          { scene: scene.id },
        );
        const head: BacklinkSceneHead = {
          id: String(scene.id),
          memberEpisodeIds: new Set((members ?? []).map((m) => String(m.out))),
        };
        for (const conversationId of scene.conversationIds) {
          const list = scenesByConversation.get(conversationId) ?? [];
          list.push(head);
          scenesByConversation.set(conversationId, list);
        }
      }

      // Conversations to reconcile. A tenant-wide run also visits the
      // ones with no scene left but a stamp still on their facts (both
      // fact walks are FLEXIBLE-source table scans — a batch admin pass).
      const conversations = new Set<string>(
        opts.conversationId !== undefined ? [opts.conversationId] : scenesByConversation.keys(),
      );
      if (opts.conversationId === undefined) {
        const [stamped] = await db.query<[unknown[]]>(
          `SELECT VALUE source.conversationId FROM knowledge_fact
            WHERE source.memoryEpisodeIds != NONE`,
        );
        for (const conversationId of stamped ?? []) {
          if (typeof conversationId === 'string') conversations.add(conversationId);
        }
      }

      for (const conversationId of conversations) {
        const [facts] = await db.query<[ReconcileFactHead[]]>(
          `SELECT id, source.episodeIds AS episodeIds,
                  source.memoryEpisodeIds AS memoryEpisodeIds,
                  source.sceneLinkVersion AS sceneLinkVersion
             FROM knowledge_fact WHERE source.conversationId = $conv`,
          { conv: conversationId },
        );
        const plan = planBacklinkReconcile(
          facts ?? [],
          scenesByConversation.get(conversationId) ?? [],
          version,
        );
        for (const write of plan.writes) {
          for (let i = 0; i < write.factIds.length; i += FACTS_PER_UPDATE) {
            await db.query(
              `UPDATE knowledge_fact SET
                 source.memoryEpisodeIds = $sceneIds,
                 source.sceneLinkVersion = $v
               WHERE id INSIDE $factIds`,
              {
                sceneIds: write.sceneIds,
                v: version,
                factIds: write.factIds.slice(i, i + FACTS_PER_UPDATE),
              },
            );
          }
        }
        result.factsLinked += plan.linked.length;
        result.stalePointersRemoved += plan.stalePointersRemoved;

        // Typed support graph (PROVENANCE_SUPPORT_EDGES, default off):
        // fact-supported_by->scene edges for the current pairs, replay-
        // idempotent (INSERT RELATION IGNORE over UNIQUE(in, out, kind));
        // writerVersion is the same effective version as the stamp. Off
        // ⇒ no memory_support query is issued at all.
        if (supportEdgesEnabled() && plan.linked.length > 0) {
          const { batches, skipped } = buildSupportEdgeBatches({
            kind: 'supported_by',
            writer: 'scene_backlink',
            writerVersion: version,
            pairs: plan.linked.flatMap((l) =>
              l.sceneIds.map((sceneId) => ({ in: String(l.factId), out: sceneId })),
            ),
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
      `scene backlink pass: ${result.factsLinked} fact(s) linked over ${result.scenes} scene(s), ` +
        `${result.stalePointersRemoved} stale pointer(s) removed`,
    );
    return result;
  }
}
