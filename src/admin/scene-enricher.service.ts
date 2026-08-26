import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { SurrealService } from '../db/surreal.service';
import { EpisodeReadStoreService, type EpisodeDb } from '../episodes/episode-read-store.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import { sceneLlmEnrichmentEnabled } from '../common/scene-flags';
import { SEGMENTER_VERSION, type SceneTurnRow } from './scene-segmentation';

/**
 * Scene LLM enricher (Brain v2 PR2, SCENES_LLM_ENRICHMENT — default off):
 * the optional pass AFTER the composer's atomic swap. For each scene of
 * the CURRENT segmenter version it makes ONE structured LLM call (strict
 * JSON schema, same call idiom as deriver-client) and updates the scene
 * row: abstractive gist replaces the deterministic render, the FULL
 * memoryValue vector lands under scorerVersion 'scene-scorer-llm-v1',
 * plus stateDeltas / unexpectedDetails and the gistPromptVersion stamp.
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

/** Stamp on memoryValue written by this enricher (0106 scorerVersion). */
export const SCENE_SCORER_LLM_VERSION = 'scene-scorer-llm-v1';
/** Stamp on the scene row for the prompt below (0106 gistPromptVersion). */
export const SCENE_GIST_PROMPT_VERSION = 'scene-gist-v1';

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
}

interface SceneHead {
  id: unknown;
  conversationIds: string[];
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

  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly episodes: EpisodeReadStoreService,
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
    const result: SceneEnrichResult = { scenes: 0, enriched: 0, failed: 0 };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not spend LLM calls past a disabled flag.
    if (!sceneLlmEnrichmentEnabled()) return result;
    if (!this.openai) {
      this.logger.warn('scene enrichment skipped: no OPENAI_API_KEY configured');
      return result;
    }
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[SceneHead[]]>(
        `SELECT id, conversationIds FROM memory_episode WHERE segmenterVersion = $v` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: SEGMENTER_VERSION,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      // One raw-turn read per conversation, shared across its scenes.
      const turnCache = new Map<string, Map<string, SceneTurnRow>>();
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        try {
          const ok = await this.enrichScene({ db, scene, turnCache });
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
  }: {
    db: EpisodeDb;
    scene: SceneHead;
    turnCache: Map<string, Map<string, SceneTurnRow>>;
  }): Promise<boolean> {
    const conversationId = scene.conversationIds[0];
    if (conversationId === undefined) return false;
    let turnsById = turnCache.get(conversationId);
    if (!turnsById) {
      const turns = (await this.episodes.conversationTurnsRaw(
        db,
        conversationId,
      )) as SceneTurnRow[];
      turnsById = new Map(turns.map((t) => [String(t.id), t]));
      turnCache.set(conversationId, turnsById);
    }
    // Plain WHERE in = $scene SELECT — safe on 3.2.4 (only DELETE trips
    // the compound-index planner bug; see scene-composer's swap comment).
    const [members] = await db.query<[Array<{ out: unknown; ord: number }>]>(
      `SELECT out, ord FROM memory_episode_member WHERE in = $scene ORDER BY ord ASC`,
      { scene: scene.id },
    );
    const memberTurns = (members ?? [])
      .map((m) => turnsById.get(String(m.out)))
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
    // the 3.2.4 secondary-index planner bug by construction.
    await db.query(
      `UPDATE $scene SET
         gist = $gist,
         gistPromptVersion = $gistPromptVersion,
         memoryValue = $memoryValue,
         stateDeltas = $stateDeltas,
         unexpectedDetails = $unexpectedDetails`,
      {
        scene: scene.id,
        gist: enrichment.gist,
        gistPromptVersion: SCENE_GIST_PROMPT_VERSION,
        memoryValue: {
          ...enrichment.memoryValue,
          scorerVersion: SCENE_SCORER_LLM_VERSION,
          scoredAt: new Date(),
        },
        stateDeltas: enrichment.stateDeltas,
        unexpectedDetails: enrichment.unexpectedDetails,
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
