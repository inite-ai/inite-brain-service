import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RecordId, StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import { scopeForUser } from '../auth/scope-tags';
import { segmentSessions } from '../episodes/session-window';
import {
  sceneEvidenceLinksEnabled,
  sceneFactBacklinkEnabled,
  sceneLlmEnrichmentEnabled,
  sceneSegmentationEnabled,
} from '../common/scene-flags';
import {
  SEGMENTER_VERSION,
  detectSceneBoundaries,
  foldSceneScope,
  meanVector,
  renderSceneGist,
  renderSceneLabel,
  scoreSceneDeterministic,
  type SceneSegmenterConfig,
  type SceneTurnRow,
} from './scene-segmentation';
import { SceneVersionService } from './scene-version';
import { SceneEnricherService } from './scene-enricher.service';
import { SceneBacklinkService } from './scene-backlink.service';
import { SceneEvidenceLinkerService } from './scene-evidence-linker.service';

/**
 * Scene composer (Brain v2 PR1): batch-derives the SHADOW memory_episode
 * substrate (migration 0106) — versioned scenes over the immutable L0
 * episode substrate — plus memory_episode_member rows binding each scene
 * to its exact member turns. Mirrors SegmentComposerService: LLM-free
 * (the only paid step is ONE optional embedding batch per conversation,
 * and only when SCENES_TOPIC_BOUNDARY is on), idempotent per
 * (conversation × segmenterVersion), and atomic — the paid batch runs
 * BEFORE any delete, then the old scene set of THIS segmenter version is
 * swapped for the new one in a single transaction. Other segmenter
 * versions' scenes are untouched, so competing segmenters coexist.
 *
 * SHADOW GUARANTEE: this service writes ONLY memory_episode /
 * memory_episode_member / projection rows. Nothing on the serving path
 * reads them — prod behavior is byte-identical whether it runs or not.
 * Lifecycle is recorded in the projection registry ('scenes'); a scene
 * world is only ever 'built', NEVER 'live' — there is no reader to flip.
 */
export const SCENE_RECORDER = 'scene-composer-v1';
// PR2: the version stamp moved to the pure segmentation module so the
// enricher/backlinker can name the current world without a module cycle;
// re-exported here for API continuity.
export { SEGMENTER_VERSION };
/** sceneLabel budget enforced in code (the 0106 header's ≤200 contract). */
const SCENE_LABEL_MAX = 200;

export interface SceneRunResult {
  conversations: number;
  scenes: number;
  skipped: Array<{ conversationId: string; reason: string }>;
}

@Injectable()
export class SceneComposerService {
  private readonly logger = new Logger(SceneComposerService.name);

  // Fourth dep is the projection-registry ledger (observes the lifecycle,
  // never fails it — every registry write degrades to a warning); the PR2
  // enricher/backlinker are the optional flag-gated post-swap passes; the
  // version service resolves the run's effective scene world once (Drift-3).
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedding: FactEmbeddingService,
    private readonly episodes: EpisodeReadStoreService,
    private readonly registry: ProjectionRegistryService,
    private readonly enricher: SceneEnricherService,
    private readonly backlinker: SceneBacklinkService,
    private readonly evidenceLinker: SceneEvidenceLinkerService,
    private readonly versions: SceneVersionService,
  ) {}

  async run(companyId: string, opts: { conversationId?: string } = {}): Promise<SceneRunResult> {
    const result: SceneRunResult = { conversations: 0, scenes: 0, skipped: [] };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not write shadow rows past a disabled flag.
    if (!sceneSegmentationEnabled()) return result;
    // One generation stamp per run (0081 idiom): every row written by this
    // rebuild carries it, so a partially-failed run is observable
    // (conversations still on the old generation = swaps that never landed).
    const generation = new Date().toISOString();
    // The effective scene world, resolved ONCE for the whole run (Drift-3):
    // flags/knobs are never re-read inside the loop, so a mid-run env flip
    // cannot mix id-spaces or stamp a version disagreeing with the content.
    const { version, cfg } = this.versions.resolve();
    await this.registry.begin({
      companyId,
      name: 'scenes',
      version,
      builder: SCENE_RECORDER,
    });
    try {
      await this.surreal.withCompany(companyId, async (db) => {
        const convs = await this.episodes.conversationCounts(db);
        for (const conv of convs) {
          const conversationId = conv.conversationId;
          // Targeted rebuild: one conversation should not force a full
          // tenant re-run (and vice versa).
          if (opts.conversationId && conversationId !== opts.conversationId) continue;
          try {
            await this.composeConversation({
              db,
              conversationId,
              result,
              generation,
              version,
              cfg,
            });
            result.conversations += 1;
          } catch (e) {
            result.skipped.push({ conversationId, reason: (e as Error).message });
            this.logger.warn(`scene compose failed for ${conversationId}: ${(e as Error).message}`);
          }
        }
      });
    } catch (e) {
      await this.registry.fail({ companyId, name: 'scenes', version });
      throw e;
    }
    // 'built', never 'live': the scene world has no serving reader to
    // promote to — activation semantics arrive with the first read lane.
    await this.registry.complete({
      companyId,
      name: 'scenes',
      version,
      live: false,
      stats: {
        conversations: result.conversations,
        scenes: result.scenes,
        skipped: result.skipped.length,
      },
    });
    // PR2 post-swap passes, both flag-gated (default off) and both
    // degrade-never-fail: the swap has landed and its result must not be
    // retracted by an optional pass. The enricher/backlinker re-check
    // their own flags too — these outer guards just skip the no-op calls.
    if (sceneLlmEnrichmentEnabled()) {
      try {
        const enrich = await this.enricher.enrich(companyId, opts);
        this.logger.log(
          `scene enrichment pass: ${enrich.enriched}/${enrich.scenes} enriched, ` +
            `${enrich.failed} degraded, ${enrich.skipped} already current`,
        );
      } catch (e) {
        this.logger.warn(`scene enrichment pass failed: ${(e as Error).message}`);
      }
    }
    if (sceneFactBacklinkEnabled()) {
      try {
        await this.backlinker.run(companyId, opts);
      } catch (e) {
        this.logger.warn(`scene backlink pass failed: ${(e as Error).message}`);
      }
    }
    if (sceneEvidenceLinksEnabled()) {
      try {
        await this.evidenceLinker.run(companyId, opts);
      } catch (e) {
        this.logger.warn(`scene evidence links pass failed: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /**
   * Purge ONE segmenter version's scene world: members then scenes, one
   * transaction, then demote the projection ledger row to 'residual' (the
   * row records that the world existed and is no longer queryable; the
   * builder stamp survives for audit — deleting the row is the gc path,
   * not the purge path). Takes ANY version string — fingerprinted
   * versions (`scene-segmenter-v1+<fp>`, SCENES_VERSION_FINGERPRINT) pass
   * through here too: this is the cleanup path for abandoned fingerprint
   * worlds after a config change forked a new id-space.
   *
   * Both deletes go through LET-selected explicit id lists. scene_version_idx
   * and scene_member_ver_idx are SINGLE-field indexes — an equality DELETE
   * should be safe — but memory_episode_member is ALSO covered by the
   * compound scene_member_uq whose planner interaction is exactly the
   * 3.2.4 silent-no-op bug (see the swap comment above), so both use the
   * id-list idiom for defensive consistency.
   */
  async purgeVersion(
    companyId: string,
    segmenterVersion: string,
  ): Promise<{ scenes: number; members: number }> {
    const purged = await this.surreal.withCompany(companyId, (db) =>
      runTransaction<{ scenes: number; members: number }>(db, (tx) =>
        tx
          .add(
            `LET $memberIds = (SELECT VALUE id FROM memory_episode_member
               WHERE segmenterVersion = $v)`,
          )
          .add(`DELETE $memberIds`)
          .add(`LET $sceneIds = (SELECT VALUE id FROM memory_episode WHERE segmenterVersion = $v)`)
          .add(`DELETE $sceneIds`)
          .add(`RETURN { scenes: array::len($sceneIds), members: array::len($memberIds) }`)
          .bind('v', segmenterVersion),
      ),
    );
    await this.registry.markResidual({ companyId, name: 'scenes', version: segmenterVersion });
    return purged ?? { scenes: 0, members: 0 };
  }

  private async composeConversation({
    db,
    conversationId,
    result,
    generation,
    version,
    cfg,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    result: SceneRunResult;
    generation: string;
    version: string;
    cfg: SceneSegmenterConfig;
  }): Promise<void> {
    const turns = (await this.episodes.conversationTurnsRaw(db, conversationId)) as SceneTurnRow[];
    if (turns.length === 0) return;

    // Paid step BEFORE any delete (segment-composer rule): an embedding
    // failure leaves the old scene set intact instead of an emptied
    // conversation. ONE batch per conversation, and only when the topic
    // boundary is on — the default segmenter is embedder-free. Resolved
    // ONCE per run (SceneVersionService), never re-read here, so the batch
    // decision always agrees with the version being stamped.
    let vectors: number[][] | undefined;
    if (cfg.topicBoundary) {
      vectors = await this.embedding.embedMany(turns.map((t) => t.text));
    }

    // Session boundaries first (shared 60-min gap rule), then the
    // within-session detector. Sessions partition `turns` in order, so a
    // running offset maps each session onto its embedding slice.
    const boundaryOpts = { minCosine: cfg.minCosine, maxTurns: cfg.maxTurns };
    const scenes: SceneTurnRow[][] = [];
    let offset = 0;
    for (const session of segmentSessions(turns) as SceneTurnRow[][]) {
      const sessionVecs = vectors?.slice(offset, offset + session.length);
      offset += session.length;
      scenes.push(...detectSceneBoundaries(session, sessionVecs, boundaryOpts));
    }
    if (scenes.length === 0) return;

    // Build scene + member rows. Scene record ids are deterministic over
    // (conversation, segmenterVersion, index) so a rebuild replaces the
    // same identities. gistEmbedding is deliberately NOT written in v1 —
    // it is the gist TEXT's vector, not the member-turn centroid we
    // compute for novelty; the PR2 encoder pass backfills it.
    const priorCentroids: number[][] = [];
    const sceneRows: Array<Record<string, unknown>> = [];
    const memberRows: Array<Record<string, unknown>> = [];
    let sceneOffset = 0;
    for (const [index, scene] of scenes.entries()) {
      const sceneVecs = (vectors?.slice(sceneOffset, sceneOffset + scene.length) ?? []).filter(
        (v): v is number[] => Array.isArray(v),
      );
      sceneOffset += scene.length;
      const centroid = sceneVecs.length > 0 ? meanVector(sceneVecs) : undefined;
      const memoryValue = scoreSceneDeterministic(centroid, priorCentroids, scene);
      if (centroid) priorCentroids.push(centroid);
      const fold = foldSceneScope(scene);
      const first = scene[0]!; // scenes are non-empty by construction
      const last = scene[scene.length - 1]!;
      const sceneId = new RecordId(
        'memory_episode',
        this.sceneIdTail(conversationId, version, index),
      );
      sceneRows.push({
        id: sceneId,
        // Scope/PII fold — same rule as segment-composer :147-160: pii is
        // the member union; userId only when single-user; a mixed-user
        // scene stays tenant-global (scopeForUser(undefined) = []).
        // userIds (0117) persists the sorted member set for the read
        // contract future scene readers must implement (foldSceneScope).
        piiClass: fold.piiClass,
        userId: fold.userId,
        userIds: fold.userIds,
        scope: scopeForUser(fold.userId),
        sceneLabel: renderSceneLabel(scene).slice(0, SCENE_LABEL_MAX),
        conversationIds: [conversationId],
        occurredFrom: new Date(first.occurredAt as string),
        occurredTo: new Date(last.occurredAt as string),
        gist: renderSceneGist(scene),
        memoryValue,
        // The deterministic segmenter is exact about its own rule — the
        // knob for "how sure was the boundary model" arrives with a
        // learned segmenter.
        confidence: 1,
        segmenterVersion: version,
        generation,
        source: { recorder: SCENE_RECORDER },
      });
      for (const [ord, turn] of scene.entries()) {
        memberRows.push({
          in: sceneId,
          out: new StringRecordId(String(turn.id)),
          role: 'core',
          ord,
          relevance: 1,
          segmenterVersion: version,
        });
      }
    }

    // Atomic swap per (conversation × segmenterVersion): old scene set of
    // THIS version out, new set in, one transaction — readers see the
    // previous set or the new one, never neither, and other segmenter
    // versions are untouched. No graph-arrow syntax anywhere (0106 note):
    // in/out are filtered as plain record fields.
    //
    // OWNERSHIP RULE (Drift-4): the delete matches conversationIds =
    // [$conv] EXACTLY — i.e. only the id-space this per-conversation
    // rebuild regenerates (the sha256(conv|version|index) ids below).
    // Byte-identical to the previous CONTAINS filter on all data this
    // producer can have written (it only ever writes [conversationId]),
    // but a future MULTI-conversation scene (consolidation output) is
    // explicitly NOT owned by a per-conversation rebuild: a CONTAINS
    // delete would destroy it whenever ANY member conversation re-runs,
    // rebuild only the re-run half, and the id scheme could not even
    // reconstruct its identity. Multi-conv scenes belong to a future
    // WORLD-LEVEL generation swap (window-deriver triad): build ALL
    // conversations into a staging id-space `<version>.staging.<runToken>`
    // (derive-staging idiom), add a `promote` verb to
    // ProjectionRegistryService (none today), then atomically delete the
    // final world + restamp staging→final in ONE transaction, with
    // multi-conv scene ids hashing a SORTED conversation-id list.
    //
    // Member delete is two-step (SELECT ids → DELETE $ids) DELIBERATELY:
    // on SurrealDB 3.2.4 a DELETE whose WHERE filters on `in` — covered
    // only by the COMPOUND scene_member_uq index — can silently match
    // NOTHING, while the same WHERE in a SELECT matches fine — verified
    // against the pinned server. Deleting by explicit ids sidesteps the
    // planner entirely (same bug class as preSweepOutcomeRows, PR #372).
    // A silent no-op here would abort the whole swap on the UNIQUE
    // (in, out) index at re-insert time.
    await runTransaction(db as unknown as Surreal, (tx) =>
      tx
        .add(
          `LET $scenes = (SELECT VALUE id FROM memory_episode
             WHERE conversationIds = [$conv] AND segmenterVersion = $v)`,
        )
        .add(
          `LET $oldMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $scenes)`,
        )
        .add(`DELETE $oldMemberIds`)
        .add(`DELETE memory_episode WHERE id INSIDE $scenes`)
        .add(`INSERT INTO memory_episode $sceneRows`)
        .add(`INSERT RELATION INTO memory_episode_member $memberRows`)
        .bind('conv', conversationId)
        .bind('v', version)
        .bind('sceneRows', sceneRows)
        .bind('memberRows', memberRows),
    );
    result.scenes += sceneRows.length;
  }

  /**
   * Deterministic scene id tail over (conversation, EFFECTIVE version,
   * index) — under SCENES_VERSION_FINGERPRINT the version carries the
   * config fingerprint, so a config change lands in a fresh id-space.
   */
  private sceneIdTail(conversationId: string, version: string, index: number): string {
    return createHash('sha256')
      .update(`${conversationId}|${version}|${index}`)
      .digest('hex')
      .slice(0, 24);
  }
}
