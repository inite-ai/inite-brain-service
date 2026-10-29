import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import type { EpisodeDb } from '../episodes/episode-read-store.service';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type ScenesTokenPayload } from '../common/harness-work-token';
import { sceneSingleUser } from './belief-promotion.service';
import { type SceneTurnRow } from './scene-segmentation';
import {
  SCENE_ENRICHMENT_SYSTEM,
  SCENE_ENRICHMENT_SYSTEM_V2,
  SceneEnricherService,
  parseSceneEnrichment,
  sceneEnrichmentRequest,
  type SceneHead,
} from './scene-enricher.service';

/** Scenes per batch: their transcripts are the bulk of the prompt. */
export const SCENES_PER_BATCH = 6;

/** What a submitted batch of scene summaries did. */
export interface ScenesSubmitOutcome {
  scenes: number;
  enriched: number;
  /** Already at the revision, re-composed away, or no longer readable. */
  stale: number;
  /** No usable summary for the scene in the reply. */
  missing: number;
}

/**
 * Harness mode (#819): scene summaries (the enrichment pass — gist,
 * memory value, state deltas, unexpected details, entity mentions) written
 * by the connected agent's model in batches. Pending scenes are the
 * pass's own (listPending), each scene's prompt block is the pass's own
 * (prepareScene + sceneEnrichmentRequest), and a summary is validated and
 * written by the pass's own code (parseSceneEnrichment + applyEnrichment),
 * stamped with the current enrichment revision so neither the pass nor a
 * later take asks for it again. Nothing is claimed; a scene summarised
 * twice is written once (the revision check on submit).
 *
 * Scope: a user's caller gets that user's single-user scenes; a
 * tenant-global caller gets scenes no user's turns are in. A mixed or
 * legacy scene is offered to no one.
 */
@Injectable()
export class SceneSummaryWorkService {
  private readonly logger = new Logger(SceneSummaryWorkService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly enricher: SceneEnricherService,
  ) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    const max = Math.max(1, Math.min(opts.max ?? SCENES_PER_BATCH, SCENES_PER_BATCH * 2));
    return this.surreal.withCompany(companyId, async (db) => {
      const run = await this.enricher.listPending(db);
      const mine = run.pending.filter((s) => inScope(s, opts.userId)).slice(0, max);
      if (mine.length === 0) return null;
      const prompts = await this.prompts(db, mine, run.predictionOn);
      if (prompts.length === 0) return null;
      // A block carries its expectation (baseline) when the scene has one;
      // the system prompt is the one that reads it. One caller's scenes
      // are all one user's (baseline) or all tenant-global (none).
      const system = prompts.some((p) => p.withBaseline)
        ? SCENE_ENRICHMENT_SYSTEM_V2
        : SCENE_ENRICHMENT_SYSTEM;
      const exp = workExpiry();
      const payload: ScenesTokenPayload = {
        v: 2,
        t: 'scene_summary',
        c: companyId,
        ...(opts.userId !== undefined ? { u: opts.userId } : {}),
        s: prompts.map((p) => String(p.scene.id)),
        ev: run.enrichmentVersion,
        n: workNonce(),
        exp,
      };
      this.logger.log(`harness work taken ${companyId}: scene_summary scenes=${prompts.length}`);
      return {
        kind: 'scene_summary',
        token: mintWorkToken(payload),
        systemPrompt: batchInstructions('scene', 's') + system,
        userContent: prompts.map((p, i) => `Scene s${i + 1}:\n${p.user}`).join('\n\n'),
        schema: batchSchema(),
        items: prompts.length,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    });
  }

  async submit(
    companyId: string,
    payload: ScenesTokenPayload,
    result: unknown,
  ): Promise<ScenesSubmitOutcome> {
    const replies = parseScenes(result);
    const out: ScenesSubmitOutcome = {
      scenes: payload.s.length,
      enriched: 0,
      stale: 0,
      missing: 0,
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const run = await this.enricher.listPending(db);
      // Still pending at the revision the prompt was built for, and still in scope.
      const pending = new Map(
        run.enrichmentVersion === payload.ev
          ? run.pending.filter((s) => inScope(s, payload.u)).map((s) => [String(s.id), s])
          : [],
      );
      const beliefs = run.predictionOn
        ? await this.enricher.beliefBaseline(db, [...pending.values()])
        : new Map();
      const turnCache = new Map<string, Map<string, SceneTurnRow>>();
      for (const [i, sceneId] of payload.s.entries()) {
        const reply = replies.get(`s${i + 1}`);
        const enrichment = reply ? parseSceneEnrichment(JSON.stringify(reply)) : null;
        if (!enrichment) {
          out.missing += 1;
          continue;
        }
        const scene = pending.get(sceneId);
        const prepared = scene
          ? await this.enricher.prepareScene({
              db,
              scene,
              turnCache,
              predictionOn: run.predictionOn,
              beliefsByUser: beliefs,
            })
          : null;
        if (!scene || !prepared) {
          out.stale += 1;
          continue;
        }
        await this.enricher.applyEnrichment({
          db,
          scene,
          prepared,
          enrichment,
          model: 'harness',
          enrichmentVersion: run.enrichmentVersion,
          entityLinksOn: run.entityLinksOn,
        });
        out.enriched += 1;
      }
    });
    this.logger.log(
      `harness work submitted ${companyId}: scene_summary scenes=${out.scenes} enriched=${out.enriched} stale=${out.stale}`,
    );
    return out;
  }

  /** Each scene's prompt block, built exactly as the pass builds it. */
  private async prompts(
    db: EpisodeDb,
    scenes: SceneHead[],
    predictionOn: boolean,
  ): Promise<Array<{ scene: SceneHead; user: string; withBaseline: boolean }>> {
    const beliefs = predictionOn ? await this.enricher.beliefBaseline(db, scenes) : new Map();
    const turnCache = new Map<string, Map<string, SceneTurnRow>>();
    const out: Array<{ scene: SceneHead; user: string; withBaseline: boolean }> = [];
    for (const scene of scenes) {
      const prepared = await this.enricher.prepareScene({
        db,
        scene,
        turnCache,
        predictionOn,
        beliefsByUser: beliefs,
      });
      if (!prepared) continue;
      out.push({
        scene,
        user: sceneEnrichmentRequest(prepared.transcript, prepared.prediction).user,
        withBaseline: prepared.prediction !== null,
      });
    }
    return out;
  }
}

/** Whose scene this is, against the caller's scope (see the class comment). */
function inScope(scene: SceneHead, userId: string | undefined): boolean {
  if (userId !== undefined) return sceneSingleUser(scene) === userId;
  return Array.isArray(scene.userIds) && scene.userIds.length === 0 && !scene.userId;
}

function batchSchema(): Record<string, unknown> {
  const one = sceneEnrichmentRequest('', null).schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scene: { type: 'string', description: 'The scene number, "s1", "s2", …' },
            ...one.properties,
          },
          required: ['scene', ...one.required],
        },
      },
    },
    required: ['scenes'],
  };
}

/** `{scenes: [{scene, …enrichment}]}` → scene number → its enrichment object. */
function parseScenes(result: unknown): Map<string, Record<string, unknown>> {
  const list = (result as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(list)) {
    throw new BadRequestException('result.scenes must be an array of scene summaries');
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const s of list as Array<Record<string, unknown>>) {
    if (typeof s?.scene !== 'string') continue;
    const key = s.scene.trim().toLowerCase();
    if (!out.has(key)) out.set(key, s);
  }
  return out;
}
