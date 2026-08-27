import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { SurrealService } from '../db/surreal.service';
import { EpisodeReadStoreService, type EpisodeDb } from '../episodes/episode-read-store.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import { sceneLlmEnrichmentEnabled } from '../common/scene-flags';
import { type SceneTurnRow } from './scene-segmentation';
import { SceneVersionService } from './scene-version';

/**
 * Scene LLM enricher (Brain v2 PR2, SCENES_LLM_ENRICHMENT — default off):
 * the optional pass AFTER the composer's atomic swap. For each scene of
 * the CURRENT effective segmenter version it makes ONE structured LLM call
 * (strict JSON schema, same call idiom as deriver-client) and writes a
 * REVISION beside the composer's deterministic originals (Drift-3b): the
 * abstractive gist lands in `enrichedGist`, the FULL memoryValue vector in
 * `enrichedMemoryValue` (scorerVersion 'scene-scorer-llm-v1'), plus
 * stateDeltas / unexpectedDetails (enrichment-owned — the deterministic
 * pass never writes them) and the `enrichmentModel` / `enrichmentVersion`
 * / `enrichedAt` stamps (migration 0118). The composer's `gist` /
 * `memoryValue` are IMMUTABLE post-compose — a composer re-run naturally
 * produces fresh un-enriched rows and the post-swap hook re-enriches.
 * `gistPromptVersion` (0106) is legacy-dead like encoderVersion — its
 * prompt identity now lives inside the enrichmentVersion composite.
 *
 * IDEMPOTENT: a scene whose `enrichmentVersion` already equals the current
 * `prompt|scorer|model` composite is SKIPPED — a re-run with unchanged
 * prompt+scorer+model makes ZERO paid calls; changing any of the three
 * changes the composite and re-enriches naturally.
 *
 * DEGRADE, NEVER FAIL: a transport error or an off-contract reply for one
 * scene logs a warning and leaves THAT scene untouched (it keeps its
 * deterministic gist/score); the pass continues. The OpenAI client is the
 * NULLABLE variant — no key means the whole pass is skipped with a
 * warning, mirroring how feature-gated callers treat "no key" as
 * feature-off (openai-client.ts).
 *
 * TESTABILITY: `openai` is a plain private field holding only the
 * `chat.completions.create` surface the service uses — tests swap it for
 * a scripted stub exactly like mockSynthesizeOpenAi (test-doubles.ts), so
 * NO paid call ever happens in CI.
 *
 * entityMentions is parsed and validated but deliberately NOT persisted:
 * the 0106 column for entity links is entityIds — RECORD refs to
 * knowledge_entity — and resolving free-text mentions into records is a
 * separate (PR3) pass; storing raw strings where records are promised
 * would poison that column's contract.
 */

/** Stamp on enrichedMemoryValue written by this enricher (scorerVersion). */
export const SCENE_SCORER_LLM_VERSION = 'scene-scorer-llm-v1';
/**
 * Version of the prompt below. No longer written to the legacy-dead
 * gistPromptVersion column — it is the first component of the
 * enrichmentVersion composite (sceneEnrichmentVersion).
 */
export const SCENE_GIST_PROMPT_VERSION = 'scene-gist-v1';

/**
 * Pure: the enrichment revision composite stored in `enrichmentVersion`
 * (0118) — readable, NOT hashed: cardinality is low and the model id must
 * stay recoverable. E.g. `scene-gist-v1|scene-scorer-llm-v1|gpt-4o-mini`.
 */
export function sceneEnrichmentVersion(model: string): string {
  return `${SCENE_GIST_PROMPT_VERSION}|${SCENE_SCORER_LLM_VERSION}|${model}`;
}

export const SCENE_ENRICHMENT_SYSTEM = `You analyze ONE scene — a contiguous span of turns from a conversation — and produce its memory encoding. Output strictly the JSON schema:
- "gist": 1-3 sentences, abstractive — what happened in this scene, who did what, with the concrete names, dates, numbers and decisions. State the content itself, never meta-language ("the user discussed" is always wrong).
- "memoryValue": how much this scene matters for long-term memory; every dimension is a number in [0,1]:
  - "novelty": how much genuinely new information appears;
  - "contradiction": how strongly it contradicts or revises what was previously established;
  - "stateChange": how much durable state changed (decisions made, plans fixed, purchases, moves);
  - "identity": how identity-central the content is (job, family, health, home, long-term goals);
  - "explicitness": how explicitly the durable content is stated rather than implied;
  - "estimatedUtility": overall likelihood this scene will be needed to answer a future question.
- "stateDeltas": durable state transitions the scene states, each {"subject", "field", "from", "to"} — subject is who/what changed, field is the changed attribute, from/to are the values (use "" for an unknown prior value). Empty array when none.
- "unexpectedDetails": short concrete details that are surprising or memorable but do not fit the gist. Empty array when none.
- "entityMentions": distinct people, places and things named in the scene. Empty array when none.`;

/** Per-dimension keys of the memoryValue vector (0106 order). */
const MEMORY_DIMS = [
  'novelty',
  'contradiction',
  'stateChange',
  'identity',
  'explicitness',
  'estimatedUtility',
] as const;

/** Caps on reply payloads — belts against a runaway model, not budgets. */
const GIST_MAX_CHARS = 2000;
const DELTAS_MAX = 20;
const DELTA_FIELD_MAX_CHARS = 200;
const DETAILS_MAX = 20;
const DETAIL_MAX_CHARS = 300;
const MENTIONS_MAX = 50;
const MENTION_MAX_CHARS = 120;
/** Transcript render caps: per-line text + visible completion budget. */
const TURN_TEXT_MAX_CHARS = 600;
const ENRICH_VISIBLE_CAP = 2000;

export interface SceneMemoryValueLlm {
  novelty: number;
  contradiction: number;
  stateChange: number;
  identity: number;
  explicitness: number;
  estimatedUtility: number;
}

export interface SceneEnrichment {
  gist: string;
  memoryValue: SceneMemoryValueLlm;
  stateDeltas: Array<{ subject: string; field: string; from: string; to: string }>;
  unexpectedDetails: string[];
  entityMentions: string[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Pure: parse + validate ONE enrichment reply. Returns null on ANY
 * malformed shape (bad JSON, empty gist, a non-numeric dimension) — the
 * caller treats null as "leave the scene untouched". Numeric dimensions
 * are clamped into [0,1]; arrays are capped and their strings trimmed so
 * an off-rubric model cannot bloat the row.
 */
export function parseSceneEnrichment(content: string): SceneEnrichment | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.gist !== 'string' || obj.gist.trim() === '') return null;
  const gist = obj.gist.replace(/\s+/g, ' ').trim().slice(0, GIST_MAX_CHARS);

  const mvRaw = obj.memoryValue;
  if (typeof mvRaw !== 'object' || mvRaw === null) return null;
  const memoryValue = {} as SceneMemoryValueLlm;
  for (const dim of MEMORY_DIMS) {
    const v = (mvRaw as Record<string, unknown>)[dim];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    memoryValue[dim] = clamp01(v);
  }

  const str = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';
  const stateDeltas = (Array.isArray(obj.stateDeltas) ? obj.stateDeltas : [])
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .slice(0, DELTAS_MAX)
    .map((d) => ({
      subject: str(d.subject, DELTA_FIELD_MAX_CHARS),
      field: str(d.field, DELTA_FIELD_MAX_CHARS),
      from: str(d.from, DELTA_FIELD_MAX_CHARS),
      to: str(d.to, DELTA_FIELD_MAX_CHARS),
    }))
    .filter((d) => d.subject !== '' && d.field !== '');
  const strings = (v: unknown, maxItems: number, maxChars: number): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .slice(0, maxItems)
      .map((s) => s.trim().slice(0, maxChars));

  return {
    gist,
    memoryValue,
    stateDeltas,
    unexpectedDetails: strings(obj.unexpectedDetails, DETAILS_MAX, DETAIL_MAX_CHARS),
    entityMentions: strings(obj.entityMentions, MENTIONS_MAX, MENTION_MAX_CHARS),
  };
}

export interface SceneEnrichResult {
  scenes: number;
  enriched: number;
  failed: number;
  /** Already at the current enrichmentVersion — no call made (idempotency). */
  skipped: number;
}

interface SceneHead {
  id: unknown;
  conversationIds: string[];
  /** Present when a previous enrichment pass stamped the row (0118). */
  enrichmentVersion?: string;
}

/** The one client surface the enricher uses (mock-swappable in tests). */
type ChatCompletionsClient = Pick<OpenAI, 'chat'>;

@Injectable()
export class SceneEnricherService {
  private readonly logger = new Logger(SceneEnricherService.name);
  /**
   * Nullable by contract (createOpenAiClient): no OPENAI_API_KEY ⇒ the
   * whole pass skips with a warning. Tests replace this field with a
   * scripted stub (mockSceneEnricherOpenAi) — the same seam as
   * SynthesizeService.openai.
   */
  private readonly openai: ChatCompletionsClient | null;
  private readonly model: string;

  // Fourth dep is the run-scoped version resolver (Drift-3): the enricher
  // must select scenes by the SAME effective version the composer stamps.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly episodes: EpisodeReadStoreService,
    private readonly versions: SceneVersionService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = configService.get<string>(
      'SCENES_ENRICH_MODEL',
      configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Enrich every scene of the CURRENT segmenter version (optionally one
   * conversation's). Never throws for a single scene — per-scene errors
   * degrade to a warning and the scene keeps its deterministic gist.
   */
  async enrich(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<SceneEnrichResult> {
    const result: SceneEnrichResult = { scenes: 0, enriched: 0, failed: 0, skipped: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not spend LLM calls past a disabled flag.
    if (!sceneLlmEnrichmentEnabled()) return result;
    if (!this.openai) {
      this.logger.warn('scene enrichment skipped: no OPENAI_API_KEY configured');
      return result;
    }
    // Effective version + revision composite, resolved ONCE per run: the
    // scene selection follows the composer's stamps, and the composite is
    // the idempotency key for the skip below.
    const { version } = this.versions.resolve();
    const enrichmentVersion = sceneEnrichmentVersion(this.model);
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[SceneHead[]]>(
        `SELECT id, conversationIds, enrichmentVersion FROM memory_episode
          WHERE segmenterVersion = $v` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      // One raw-turn read per conversation, shared across its scenes.
      const turnCache = new Map<string, Map<string, SceneTurnRow>>();
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        // Idempotent skip: this scene already carries the current
        // prompt|scorer|model revision — zero paid calls on a re-run.
        if (scene.enrichmentVersion === enrichmentVersion) {
          result.skipped += 1;
          this.logger.debug(
            `scene enrichment skipped ${String(scene.id)}: already at ${enrichmentVersion}`,
          );
          continue;
        }
        try {
          const ok = await this.enrichScene({ db, scene, turnCache, enrichmentVersion });
          if (ok) result.enriched += 1;
          else result.failed += 1;
        } catch (e) {
          result.failed += 1;
          this.logger.warn(
            `scene enrichment failed for ${String(scene.id)}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  /** One scene: transcript → ONE structured call → validated UPDATE. */
  private async enrichScene({
    db,
    scene,
    turnCache,
    enrichmentVersion,
  }: {
    db: EpisodeDb;
    scene: SceneHead;
    turnCache: Map<string, Map<string, SceneTurnRow>>;
    enrichmentVersion: string;
  }): Promise<boolean> {
    if (scene.conversationIds.length === 0) return false;
    // Member lookup merged over ALL of the scene's conversations (the
    // cache stays per-conversation): identical behavior today — the
    // composer only writes single-conversation scenes — but a future
    // multi-conversation scene is enriched from its FULL transcript
    // instead of silently reading only conversationIds[0].
    const conversationMaps: Array<Map<string, SceneTurnRow>> = [];
    for (const conversationId of scene.conversationIds) {
      let turnsById = turnCache.get(conversationId);
      if (!turnsById) {
        const turns = (await this.episodes.conversationTurnsRaw(
          db,
          conversationId,
        )) as SceneTurnRow[];
        turnsById = new Map(turns.map((t) => [String(t.id), t]));
        turnCache.set(conversationId, turnsById);
      }
      conversationMaps.push(turnsById);
    }
    const lookupTurn = (id: string): SceneTurnRow | undefined => {
      for (const m of conversationMaps) {
        const t = m.get(id);
        if (t) return t;
      }
      return undefined;
    };
    // Plain WHERE in = $scene SELECT — safe on 3.2.4 (only DELETE trips
    // the compound-index planner bug; see scene-composer's swap comment).
    const [members] = await db.query<[Array<{ out: unknown; ord: number }>]>(
      `SELECT out, ord FROM memory_episode_member WHERE in = $scene ORDER BY ord ASC`,
      { scene: scene.id },
    );
    const memberTurns = (members ?? [])
      .map((m) => lookupTurn(String(m.out)))
      .filter((t): t is SceneTurnRow => t !== undefined);
    if (memberTurns.length === 0) {
      this.logger.warn(`scene enrichment skipped ${String(scene.id)}: no member turns readable`);
      return false;
    }

    const transcript = memberTurns
      .map((t) => {
        const iso = new Date(t.occurredAt as string).toISOString();
        const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
        return `(${stamp}) ${t.speaker ?? 'unknown'}: ${t.text.slice(0, TURN_TEXT_MAX_CHARS)}`;
      })
      .join('\n');
    const enrichment = await this.callModel(transcript);
    if (!enrichment) {
      this.logger.warn(
        `scene enrichment reply malformed for ${String(scene.id)} — scene keeps its deterministic gist`,
      );
      return false;
    }

    // Single-record UPDATE by bound id — primary-key addressed, immune to
    // the 3.2.4 secondary-index planner bug by construction. Writes ONLY
    // the enrichment-revision siblings + stamps (0118): the composer's
    // deterministic gist / memoryValue are immutable post-compose, and
    // gistPromptVersion is legacy-dead (superseded by enrichmentVersion).
    await db.query(
      `UPDATE $scene SET
         enrichedGist = $gist,
         enrichedMemoryValue = $memoryValue,
         stateDeltas = $stateDeltas,
         unexpectedDetails = $unexpectedDetails,
         enrichmentModel = $model,
         enrichmentVersion = $enrichmentVersion,
         enrichedAt = time::now()`,
      {
        scene: scene.id,
        gist: enrichment.gist,
        memoryValue: {
          ...enrichment.memoryValue,
          scorerVersion: SCENE_SCORER_LLM_VERSION,
          scoredAt: new Date(),
        },
        stateDeltas: enrichment.stateDeltas,
        unexpectedDetails: enrichment.unexpectedDetails,
        model: this.model,
        enrichmentVersion,
      },
    );
    return true;
  }

  /** ONE strict-schema chat call (deriver-client idiom); null = degrade. */
  private async callModel(transcript: string): Promise<SceneEnrichment | null> {
    const res = await this.openai!.chat.completions.create({
      model: this.model,
      ...chatCallParams(this.model, { temperature: 0, visibleCap: ENRICH_VISIBLE_CAP }),
      messages: [
        { role: 'system', content: SCENE_ENRICHMENT_SYSTEM },
        { role: 'user', content: `Scene transcript:\n${transcript}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'scene_enrichment',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              gist: { type: 'string' },
              memoryValue: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(MEMORY_DIMS.map((d) => [d, { type: 'number' }])),
                required: [...MEMORY_DIMS],
              },
              stateDeltas: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subject: { type: 'string' },
                    field: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                  required: ['subject', 'field', 'from', 'to'],
                },
              },
              unexpectedDetails: { type: 'array', items: { type: 'string' } },
              entityMentions: { type: 'array', items: { type: 'string' } },
            },
            required: ['gist', 'memoryValue', 'stateDeltas', 'unexpectedDetails', 'entityMentions'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    return parseSceneEnrichment(content);
  }
}
