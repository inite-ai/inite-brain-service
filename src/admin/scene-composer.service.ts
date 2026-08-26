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
  sceneMaxTurns,
  sceneSegmentationEnabled,
  sceneTopicBoundaryEnabled,
  sceneTopicMinCosine,
} from '../common/scene-flags';
import {
  detectSceneBoundaries,
  foldSceneScope,
  meanVector,
  renderSceneGist,
  renderSceneLabel,
  scoreSceneDeterministic,
  type SceneTurnRow,
} from './scene-segmentation';

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
export const SEGMENTER_VERSION = 'scene-segmenter-v1';
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
  // never fails it — every registry write degrades to a warning).
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedding: FactEmbeddingService,
    private readonly episodes: EpisodeReadStoreService,
    private readonly registry: ProjectionRegistryService,
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
    await this.registry.begin({
      companyId,
      name: 'scenes',
      version: SEGMENTER_VERSION,
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
            await this.composeConversation({ db, conversationId, result, generation });
            result.conversations += 1;
          } catch (e) {
            result.skipped.push({ conversationId, reason: (e as Error).message });
            this.logger.warn(`scene compose failed for ${conversationId}: ${(e as Error).message}`);
          }
        }
      });
    } catch (e) {
      await this.registry.fail({ companyId, name: 'scenes', version: SEGMENTER_VERSION });
      throw e;
    }
    // 'built', never 'live': the scene world has no serving reader to
    // promote to — activation semantics arrive with the first read lane.
    await this.registry.complete({
      companyId,
      name: 'scenes',
      version: SEGMENTER_VERSION,
      live: false,
      stats: {
        conversations: result.conversations,
        scenes: result.scenes,
        skipped: result.skipped.length,
      },
    });
    return result;
  }

  private async composeConversation({
    db,
    conversationId,
    result,
    generation,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    result: SceneRunResult;
    generation: string;
  }): Promise<void> {
    const turns = (await this.episodes.conversationTurnsRaw(db, conversationId)) as SceneTurnRow[];
    if (turns.length === 0) return;

    // Paid step BEFORE any delete (segment-composer rule): an embedding
    // failure leaves the old scene set intact instead of an emptied
    // conversation. ONE batch per conversation, and only when the topic
    // boundary is on — the default segmenter is embedder-free.
    let vectors: number[][] | undefined;
    if (sceneTopicBoundaryEnabled()) {
      vectors = await this.embedding.embedMany(turns.map((t) => t.text));
    }

    // Session boundaries first (shared 60-min gap rule), then the
    // within-session detector. Sessions partition `turns` in order, so a
    // running offset maps each session onto its embedding slice.
    const boundaryOpts = { minCosine: sceneTopicMinCosine(), maxTurns: sceneMaxTurns() };
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
      const sceneId = new RecordId('memory_episode', this.sceneIdTail(conversationId, index));
      sceneRows.push({
        id: sceneId,
        // Scope/PII fold — same rule as segment-composer :147-160: pii is
        // the member union; userId only when single-user; a mixed-user
        // scene stays tenant-global (scopeForUser(undefined) = []).
        piiClass: fold.piiClass,
        userId: fold.userId,
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
        segmenterVersion: SEGMENTER_VERSION,
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
          segmenterVersion: SEGMENTER_VERSION,
        });
      }
    }

    // Atomic swap per (conversation × segmenterVersion): old scene set of
    // THIS version out, new set in, one transaction — readers see the
    // previous set or the new one, never neither, and other segmenter
    // versions are untouched. No graph-arrow syntax anywhere (0106 note):
    // in/out are filtered as plain record fields.
    await runTransaction(db as unknown as Surreal, (tx) =>
      tx
        .add(
          `LET $scenes = (SELECT VALUE id FROM memory_episode
             WHERE conversationIds CONTAINS $conv AND segmenterVersion = $v)`,
        )
        .add(`DELETE memory_episode_member WHERE in INSIDE $scenes`)
        .add(`DELETE memory_episode WHERE id INSIDE $scenes`)
        .add(`INSERT INTO memory_episode $sceneRows`)
        .add(`INSERT RELATION INTO memory_episode_member $memberRows`)
        .bind('conv', conversationId)
        .bind('v', SEGMENTER_VERSION)
        .bind('sceneRows', sceneRows)
        .bind('memberRows', memberRows),
    );
    result.scenes += sceneRows.length;
  }

  /** Deterministic scene id tail over (conversation, version, index). */
  private sceneIdTail(conversationId: string, index: number): string {
    return createHash('sha256')
      .update(`${conversationId}|${SEGMENTER_VERSION}|${index}`)
      .digest('hex')
      .slice(0, 24);
  }
}
