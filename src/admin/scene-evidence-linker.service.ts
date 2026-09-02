import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { sceneEvidenceLinksEnabled } from '../common/scene-flags';
import { SceneVersionService } from './scene-version';
import { unionEvidenceRefs } from '../common/evidence-ref';
import { buildSupportEdgeBatches, classifySupportTarget } from '../common/support-edges';

/**
 * Scene evidence linker (MM-zoom PR1, SCENES_EVIDENCE_LINKS — default
 * off): writes typed scene-reconstructed_from->evidence edges into
 * memory_support (0116, kind activated by 0123) so a scene becomes
 * zoomable into the multimodal evidence substrate (0109). For every
 * memory_episode of the CURRENT effective segmenter version it unions
 * the member episodes' `source.evidenceRefs` (unionEvidenceRefs — the
 * FLEXIBLE-source discipline: shapes are never guaranteed), keeps the
 * evidence_fragment/evidence_asset refs, and inserts one edge per
 * (scene, ref) pair:
 *
 *   scene -reconstructed_from-> evidence_fragment | evidence_asset
 *   (writer 'scene_evidence_linker', writerVersion = the effective
 *   segmenter version, resolved once per run — SceneVersionService)
 *
 * Replay-idempotent by construction: INSERT RELATION IGNORE over
 * UNIQUE(in, out, kind) — a re-run (or a re-segmentation re-run onto
 * the same deterministic scene ids) inserts nothing new. Episodes
 * carrying NO evidence refs are a GRACEFUL NO-OP (zero writes) — the
 * metadata-ingest path is the producer of source.evidenceRefs and may
 * not have run for this tenant. Scene -> turn membership stays in
 * memory_episode_member (0106); this pass never touches it.
 *
 * GDPR: both forget cascades erase these edges UNCONDITIONALLY (the
 * dying-scene `in` legs and the dying-evidence `out` leg) — rows
 * written while SCENES_EVIDENCE_LINKS was on must stay erasable after
 * it is off (the EVIDENCE_SUBSTRATE_ENABLED precedent).
 */

/** Minimal scene head the pass reads. */
interface LinkerSceneRow {
  id: unknown;
}

/**
 * Pure: member episodes' evidence-ref lists -> deduped edge targets.
 * unionEvidenceRefs handles the FLEXIBLE-source coercion (String(),
 * known record prefixes only, member order preserved, capped at 64);
 * the filter keeps the two linkable classes — 'episode:' refs are
 * membership-plane pointers, not reconstruction evidence.
 */
export function evidenceLinkTargets(memberRefLists: readonly unknown[]): string[] {
  return unionEvidenceRefs(memberRefLists).filter((ref) => {
    const cls = classifySupportTarget(ref);
    return cls === 'fragment' || cls === 'asset';
  });
}

export interface SceneEvidenceLinkResult {
  /** Scenes of the current effective version examined. */
  scenes: number;
  /** Scenes that produced at least one edge row this run. */
  scenesLinked: number;
  /** Edge rows written across all scenes (post-dedupe, pre-IGNORE). */
  edges: number;
}

@Injectable()
export class SceneEvidenceLinkerService {
  private readonly logger = new Logger(SceneEvidenceLinkerService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly versions: SceneVersionService,
  ) {}

  async run(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<SceneEvidenceLinkResult> {
    const result: SceneEvidenceLinkResult = { scenes: 0, scenesLinked: 0, edges: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not write edges past a disabled flag.
    if (!sceneEvidenceLinksEnabled()) return result;
    // Effective version resolved ONCE per run (the backlink discipline):
    // the scene selection and the writerVersion stamp name ONE world.
    const { version } = this.versions.resolve();
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[LinkerSceneRow[]]>(
        `SELECT id FROM memory_episode WHERE segmenterVersion = $v` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        const [members] = await db.query<[Array<{ out: unknown }>]>(
          `SELECT out FROM memory_episode_member WHERE in = $scene`,
          { scene: scene.id },
        );
        const memberRefs = (members ?? []).map((m) => m.out);
        if (memberRefs.length === 0) continue;
        // One batched read of the members' evidence-ref lists. SELECT
        // VALUE of a missing FLEXIBLE key yields NONE per row —
        // unionEvidenceRefs skips every non-array, so an episode world
        // without a metadata-ingest producer is a graceful no-op.
        const [refLists] = await db.query<[unknown[]]>(
          `SELECT VALUE source.evidenceRefs FROM episode WHERE id INSIDE $eps`,
          { eps: memberRefs },
        );
        const targets = evidenceLinkTargets((refLists ?? []) as unknown[]);
        if (targets.length === 0) continue;
        const { batches, skipped } = buildSupportEdgeBatches({
          kind: 'reconstructed_from',
          writer: 'scene_evidence_linker',
          writerVersion: version,
          pairs: targets.map((out) => ({ in: String(scene.id), out })),
        });
        if (skipped > 0) {
          this.logger.warn(`scene evidence links: ${skipped} malformed edge pair(s) skipped`);
        }
        let written = 0;
        for (const batch of batches) {
          await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
            rows: batch.map((r) => ({
              ...r,
              in: new StringRecordId(r.in),
              out: new StringRecordId(r.out),
            })),
          });
          written += batch.length;
        }
        if (written > 0) {
          result.scenesLinked += 1;
          result.edges += written;
        }
      }
    });
    this.logger.log(
      `scene evidence links pass: ${result.edges} edge(s) over ` +
        `${result.scenesLinked}/${result.scenes} scene(s)`,
    );
    return result;
  }
}
