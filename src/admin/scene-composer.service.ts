import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RecordId, StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import { getActiveRetrievalProfile } from '../search/retrieval-profile';
import { scopeForUser } from '../auth/scope-tags';
import { segmentSessions } from '../episodes/session-window';
import {
  sceneEvidenceLinksEnabled,
  sceneFactBacklinkEnabled,
  sceneGistEmbeddingEnabled,
  sceneLlmEnrichmentEnabled,
  sceneSegmentationEnabled,
} from '../common/scene-flags';
import {
  SEGMENTER_VERSION,
  deriveSceneConfidence,
  detectSceneSegments,
  foldSceneScope,
  meanVector,
  renderSceneGist,
  renderSceneLabel,
  scoreSceneDeterministic,
  type SceneSegment,
  type SceneSegmenterConfig,
  type SceneTurnRow,
} from './scene-segmentation';
import { SceneVersionService } from './scene-version';
import { SceneEnricherService } from './scene-enricher.service';
import { SceneBacklinkService } from './scene-backlink.service';
import { SceneEvidenceLinkerService } from './scene-evidence-linker.service';
import { SceneGistEmbeddingService } from './scene-gist-embedding.service';

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
 * WRITE SURFACE: this service writes ONLY memory_episode /
 * memory_episode_member / projection rows. Lifecycle is recorded in the
 * projection registry ('scenes').
 *
 * ACTIVATION (was: the SHADOW GUARANTEE). Until RETRIEVAL_SCENE_LANE
 * there was no serving reader, so a scene world registered 'built' and
 * NEVER 'live' — nothing to flip. SceneLaneService is that reader now,
 * and it serves exactly the version the registry marks 'live', so the
 * completion below promotes when the asking tenant's profile enables
 * the lane. With the lane off (the default) the world still registers
 * 'built', nothing on the serving path reads these tables, and prod
 * behavior is byte-identical whether this service runs or not.
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
  /**
   * Scenes the post-swap enrichment pass actually re-wrote (the paid leg).
   * ABSENT unless SCENES_LLM_ENRICHMENT is on and the pass ran to
   * completion — an additive field, so a flag-off response is unchanged.
   * Surfaced because the enrichment call count IS the run's model bill and
   * the scheduled pass has to be able to meter it without reaching past
   * the composer into the enricher.
   */
  enriched?: number;
  /**
   * Scenes the post-swap gist-encoder pass gave a vector (PR3, the
   * SCENES_GIST_EMBEDDING leg). ABSENT unless the flag is on and the pass
   * ran to completion — an additive field, so a flag-off response is
   * unchanged. Surfaced for the same reason as `enriched`: the vector
   * count IS the run's embedding bill, and the scheduled pass must be able
   * to meter it without reaching past the composer into the encoder.
   */
  gistEmbedded?: number;
}

/**
 * Which conversations a run covers.
 *
 *  - neither key  — the admin full rebuild: enumerate every conversation
 *    that has episodes (the O(all turns) GROUP BY) and recompose all of
 *    them. Unchanged since PR1; this is what the operator button does.
 *  - `conversationId` — the admin targeted rebuild. Also unchanged: the
 *    same enumeration, filtered down to one id (so a conversation with no
 *    episodes is genuinely absent from the result rather than counted).
 *  - `conversationIds` — the SCHEDULED path (SCENES_SCHEDULED_MAINTENANCE):
 *    the caller has already resolved the exact working set from the dirty
 *    marks (migration 0130), so the enumeration is SKIPPED entirely and
 *    these ids are composed directly. This is the whole point of the dirty
 *    trigger — a nightly pass must be proportional to what moved, not to
 *    what exists. An EMPTY array composes nothing: the key is present, so
 *    the working set is known, and it is empty. It deliberately does not
 *    fall back to the full enumeration — a caller that lost its working set
 *    must do nothing, not spend a corpus-wide paid rebuild.
 */
export interface SceneRunOptions {
  conversationId?: string;
  conversationIds?: string[];
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
    private readonly gistEncoder: SceneGistEmbeddingService,
  ) {}

  async run(companyId: string, opts: SceneRunOptions = {}): Promise<SceneRunResult> {
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
        // Scheduled path: the working set arrived already resolved from the
        // dirty marks, so the O(all turns) enumeration is skipped whole.
        // Admin paths keep it (and keep filtering it) byte-identically.
        const convs: Array<{ conversationId: string }> =
          opts.conversationIds !== undefined
            ? opts.conversationIds.map((conversationId) => ({ conversationId }))
            : await this.episodes.conversationCounts(db);
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
    // ACTIVATION (RETRIEVAL_SCENE_LANE). The read lane the old contract
    // waited for now exists (SceneLaneService — the episodic plane's
    // first serving reader), so the world registers 'live' exactly when
    // the asking tenant actually serves scenes, and 'built' otherwise —
    // the pre-lane behavior, byte-identical with the field off.
    //
    // The registry needed NO new verb: `complete({live})` IS the
    // promotion (it stamps 'live' AND demotes the previous live version
    // of this name to 'residual'), and the lane reads whatever version
    // carries 'live'. Consequence, documented on the config-catalog
    // entry: enabling the field on a tenant whose scenes were built
    // while it was off needs one composer re-run to promote the world.
    //
    // getActiveRetrievalProfile() is the ONE resolution path for the
    // field — the admin request's stamped per-tenant profile, falling
    // back to the boot default outside a request — so a tenant override
    // that enables the lane also promotes its world.
    await this.registry.complete({
      companyId,
      name: 'scenes',
      version,
      live: getActiveRetrievalProfile().sceneLane,
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
    //
    // The three passes take a SINGLE optional conversationId, so the
    // scheduled multi-conversation working set narrows to nothing here and
    // they run over the whole current scene world. That is correct AND
    // cheap: all three are idempotent (the enricher skips scenes already at
    // the current enrichmentVersion composite, the backlinker unions, the
    // linker INSERT-RELATION-IGNOREs), so the paid work is bounded by the
    // scenes this run actually changed, not by the size of the world.
    const passOpts =
      opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {};
    // PR3 encoder pass: the producer of the 0106 `gistEmbedding` column
    // (SceneGistEmbeddingService). It runs FIRST of the post-swap chain
    // because it encodes the swap's own output — the canonical `gist` text
    // — and because it is the cheapest leg: ONE embedMany batch over the
    // vector-less scenes of this world, bounded per run and idempotent.
    // Order against the enricher is immaterial by construction: the
    // enricher writes the `enrichedGist` REVISION sibling and never
    // touches `gist`, so the vector can never go stale relative to the
    // text it encodes.
    if (sceneGistEmbeddingEnabled()) {
      try {
        const encoded = await this.gistEncoder.run(companyId, passOpts);
        result.gistEmbedded = encoded.embedded;
        this.logger.log(
          `scene gist encoder pass: ${encoded.embedded}/${encoded.scenes} embedded, ` +
            `${encoded.skipped} unusable, ${encoded.failed} failed`,
        );
      } catch (e) {
        this.logger.warn(`scene gist encoder pass failed: ${(e as Error).message}`);
      }
    }
    if (sceneLlmEnrichmentEnabled()) {
      try {
        const enrich = await this.enricher.enrich(companyId, passOpts);
        result.enriched = enrich.enriched;
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
        await this.backlinker.run(companyId, passOpts);
      } catch (e) {
        this.logger.warn(`scene backlink pass failed: ${(e as Error).message}`);
      }
    }
    if (sceneEvidenceLinksEnabled()) {
      try {
        await this.evidenceLinker.run(companyId, passOpts);
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
    // Segments, not bare turn arrays: each one remembers which rule made
    // its two edges, which is the input to the confidence derivation below.
    const segments: Array<SceneSegment<SceneTurnRow>> = [];
    let offset = 0;
    for (const session of segmentSessions(turns) as SceneTurnRow[][]) {
      const sessionVecs = vectors?.slice(offset, offset + session.length);
      offset += session.length;
      segments.push(...detectSceneSegments(session, sessionVecs, boundaryOpts));
    }
    if (segments.length === 0) return;

    // Build scene + member rows. Scene record ids are deterministic over
    // (conversation, segmenterVersion, index) so a rebuild replaces the
    // same identities. gistEmbedding is NOT written HERE — it is the gist
    // TEXT's vector, not the member-turn centroid we compute for novelty,
    // and the two must not be conflated. Its producer is the post-swap
    // encoder pass (SceneGistEmbeddingService, SCENES_GIST_EMBEDDING),
    // which embeds the `gist` this loop renders once the swap has landed:
    // the paid step stays OUT of the pre-delete critical section, and a
    // vector-less world is a graceful state the lane degrades through.
    const priorCentroids: number[][] = [];
    const sceneRows: Array<Record<string, unknown>> = [];
    const memberRows: Array<Record<string, unknown>> = [];
    let sceneOffset = 0;
    for (const [index, segment] of segments.entries()) {
      const scene = segment.turns;
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
        // Derived from the two edges that delimit this scene (see
        // deriveSceneConfidence): an EXACT rule — the 60-minute session
        // gap or the SCENES_MAX_TURNS cap — is certain and stays 1;
        // a topic-cosine edge scores by how far the cosine fell below
        // the floor, so a barely-cleared split stops claiming certainty.
        // With SCENES_TOPIC_BOUNDARY off no cosine edge can exist, so
        // every scene is 1 — byte-identical to the constant it replaces.
        confidence: deriveSceneConfidence(segment, {
          minCosine: cfg.minCosine,
          topicBoundary: cfg.topicBoundary,
        }),
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
