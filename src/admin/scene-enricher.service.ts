import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, type Surreal } from 'surrealdb';
import type OpenAI from 'openai';
import { SurrealService } from '../db/surreal.service';
import { EpisodeReadStoreService, type EpisodeDb } from '../episodes/episode-read-store.service';
import { EntityUpsertService } from '../ingest/entity-upsert.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import {
  sceneEntityLinksEnabled,
  sceneLlmEnrichmentEnabled,
  scenePredictionBaselineEnabled,
} from '../common/scene-flags';
import { type SceneTurnRow } from './scene-segmentation';
import { sceneSingleUser } from './belief-promotion.service';
import { selectSceneMentions, stableEntityIds } from './scene-entity-links';
import {
  baselineRefPayload,
  loadActiveBeliefBaseline,
  renderBaselineBlock,
  sceneBaseline,
  scorePredictionError,
  SCENE_PREDICTION_SCORER_VERSION,
  type BaselineBelief,
  type ScenePredictionError,
} from './scene-prediction-baseline';
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
 * PREDICTION BASELINE (SCENES_PREDICTION_BASELINE, default off). With the
 * flag on the pass stops GUESSING surprise. Before the call it loads the
 * scene user's ACTIVE semantic_belief rows (ONE bounded SELECT per run,
 * scene-prediction-baseline.ts), renders them as an explicit "what the
 * system believed BEFORE this scene" block under the scene-gist-v2 prompt
 * (contradiction / unexpectedDetails become observed-vs-expected), stamps
 * the snapshot onto the scene as `baselineRef` (0106 FLEXIBLE — no
 * migration), and then MEASURES contradiction / stateChange / identity
 * with a deterministic no-model-call scorer over the same baseline plus
 * the returned stateDeltas, overriding the model's numbers for exactly
 * those dimensions (scorerVersion composite `scene-scorer-llm-v1+
 * scene-scorer-v1` names both producers). A dimension the scorer cannot
 * measure keeps the model's guess — an unknown baseline is NOT a
 * confident zero. Flag off ⇒ zero extra queries, the byte-identical
 * scene-gist-v1 prompt/composite and no baselineRef write.
 *
 * NOTE ON `baselineRef` SHARING: belief promotion also writes this column,
 * but only on a REVISION and only for the scenes carrying the winning
 * value, with a different shape ({belief, revision, value, stampedAt} — a
 * backpointer to what was displaced). The two are self-describing (`beliefs`
 * array + `baselineVersion` here vs a single `belief` there); a promotion
 * revision run after enrichment replaces the expectation snapshot, and a
 * re-enrichment restores it. Namespacing the two writers under distinct
 * keys is the obvious follow-up and belongs in the promotion service.
 *
 * ENTITY LINKS (SCENES_ENTITY_LINKS, default off) — PR3, the pass PR2
 * deferred. Until now `entityMentions` was parsed, validated and THROWN
 * AWAY: the 0106 column for entity links is `entityIds` — RECORD refs to
 * knowledge_entity — and storing raw strings where records are promised
 * would poison that column's contract. With the flag on, each scene's
 * mentions are RESOLVED against the graph through the platform's own
 * deterministic resolution (EntityUpsertService.resolveExistingByName:
 * exact canonicalName/alias, then the INGEST_ARTICLE_NORMALIZATION
 * variants and the INGEST_CODE_ALIAS_RESOLUTION path↔symbol convention
 * when those are on) and the resolved refs land in `entityIds`.
 *
 *  - RESOLVE-ONLY, NEVER MINT. A scene is a RECONSTRUCTION of turns that
 *    were already ingested, not a source of truth: every entity it can
 *    legitimately name already exists, so a mention that resolves to
 *    nothing is DROPPED. No knowledge_entity row is created, no alias is
 *    stamped on the entity the link points at, no merge-log row is
 *    written — and the probabilistic embedding+judge resolver is not in
 *    the ladder at all (a low-confidence fuse is the wrong trade for an
 *    unasked-for backlink). Ambiguity — two entities carrying the name —
 *    also links NOTHING.
 *  - SCOPE. The #387 single-user fence decides what the scene may see: a
 *    single-user scene resolves against tenant-global entities PLUS its
 *    own user's; a mixed-user, tenant-global or legacy (pre-0117) scene
 *    resolves against tenant-global entities ONLY. A foreign user's
 *    entity can therefore never appear on a scene. The 0093 scope-tag
 *    fence ANDs alongside.
 *  - BOUNDED. At most SCENE_ENTITY_LINKS_MAX mentions are attempted per
 *    scene, so the resolution cost stays an order of magnitude under the
 *    one LLM call that produced them.
 *  - IDEMPOTENT. The resolved set (de-duplicated and SORTED) fully
 *    REPLACES the column, so a re-enrichment over an unchanged corpus
 *    writes a byte-identical value; an empty result writes `[]` — "we
 *    looked and found nothing" is a fact worth recording, and it is
 *    stable across re-runs in a way an absent column is not.
 *  - DEGRADE. A resolution failure warns and drops that mention; the
 *    enrichment write still lands.
 *
 * `relationIds` — the sibling 0106 column — stays UNWRITTEN, deliberately.
 * Nothing in the scene pipeline produces knowledge_edge relations: the
 * enrichment schema returns MENTIONS and stateDeltas, neither of which is
 * a typed entity→entity edge, and taking the cross-product of the resolved
 * entities to look up edges that already exist would assert "this scene is
 * evidence for that relation" on evidence the scene never gave. A column
 * left NONE says "no producer"; a column filled by inference says
 * something false. The honest producer is a relation-extraction pass that
 * does not exist yet.
 */

/** Stamp on enrichedMemoryValue written by this enricher (scorerVersion). */
export const SCENE_SCORER_LLM_VERSION = 'scene-scorer-llm-v1';
/**
 * Version of the v1 prompt below. No longer written to the legacy-dead
 * gistPromptVersion column — it is the first component of the
 * enrichmentVersion composite (sceneEnrichmentVersion).
 *
 * FROZEN. A prompt version names a prompt STRING: v1 must never be edited
 * once rows carry its stamp, or the stamp stops identifying what the
 * model actually saw. Prompt changes ship as a NEW constant + version.
 */
export const SCENE_GIST_PROMPT_VERSION = 'scene-gist-v1';
/** Version of the prediction-baseline prompt (SCENES_PREDICTION_BASELINE). */
export const SCENE_GIST_PROMPT_VERSION_V2 = 'scene-gist-v2';

/**
 * Pure: the prompt version this run uses. The baseline flag changes the
 * SYSTEM PROMPT (deviation-from-model instead of free saliency), so it
 * must change the prompt identity too — otherwise two different prompts
 * would share one stamp and the idempotency skip would refuse to
 * re-enrich after a flip.
 */
export function sceneGistPromptVersion(predictionBaseline: boolean): string {
  return predictionBaseline ? SCENE_GIST_PROMPT_VERSION_V2 : SCENE_GIST_PROMPT_VERSION;
}

/**
 * Pure: the scorer identity of the enriched vector. With the prediction
 * baseline on, contradiction / stateChange / identity come from the
 * deterministic scorer and the rest from the model — the composite names
 * BOTH producers so a mixed-scorer world stays auditable (the same reason
 * the v0 vector stamps its own scorerVersion).
 */
export function sceneScorerVersion(predictionBaseline: boolean): string {
  return predictionBaseline
    ? `${SCENE_SCORER_LLM_VERSION}+${SCENE_PREDICTION_SCORER_VERSION}`
    : SCENE_SCORER_LLM_VERSION;
}

/**
 * Pure: the enrichment revision composite stored in `enrichmentVersion`
 * (0118) — readable, NOT hashed: cardinality is low and the model id must
 * stay recoverable. E.g. `scene-gist-v1|scene-scorer-llm-v1|gpt-4o-mini`,
 * or `scene-gist-v2|scene-scorer-llm-v1+scene-scorer-v1|gpt-4o-mini` with
 * the prediction baseline on — so flipping the flag either way re-enriches
 * naturally instead of leaving a mixed world behind one stamp.
 */
export function sceneEnrichmentVersion(model: string, predictionBaseline = false): string {
  return `${sceneGistPromptVersion(predictionBaseline)}|${sceneScorerVersion(predictionBaseline)}|${model}`;
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

/**
 * Prediction-baseline prompt (scene-gist-v2, SCENES_PREDICTION_BASELINE).
 *
 * The ONLY substantive difference from v1: the user message carries a
 * "Current model of the world" block, and `contradiction` /
 * `unexpectedDetails` are defined as DEVIATION FROM THAT MODEL —
 * observed-vs-expected — instead of free-floating saliency. Held as its
 * own frozen literal rather than assembled from v1: a prompt version must
 * name a fixed string, and sharing fragments would let a later v2 edit
 * silently rewrite what v1-stamped rows claim the model saw.
 */
export const SCENE_ENRICHMENT_SYSTEM_V2 = `You analyze ONE scene — a contiguous span of turns from a conversation — and produce its memory encoding. The user message first states the system's CURRENT MODEL OF THE WORLD (what it believed before this scene) and then the scene transcript. Your job is prediction error: report what the scene changes about that model.
- "gist": 1-3 sentences, abstractive — what happened in this scene, who did what, with the concrete names, dates, numbers and decisions. State the content itself, never meta-language ("the user discussed" is always wrong).
- "memoryValue": how much this scene matters for long-term memory; every dimension is a number in [0,1]:
  - "novelty": how much genuinely new information appears;
  - "contradiction": how far the scene DEVIATES from the stated model of the world — 0 when it confirms the model or only adds to it, high when it overturns a value the model states. Judge against the stated model, never against your own expectations; when the model states nothing, there is nothing to contradict;
  - "stateChange": how much durable state changed (decisions made, plans fixed, purchases, moves);
  - "identity": how identity-central the content is (job, family, health, home, long-term goals);
  - "explicitness": how explicitly the durable content is stated rather than implied;
  - "estimatedUtility": overall likelihood this scene will be needed to answer a future question.
- "stateDeltas": durable state transitions the scene states, each {"subject", "field", "from", "to"} — subject is who/what changed, field is the changed attribute, from/to are the values (use "" for an unknown prior value). When the model of the world already states a value for that subject and attribute, use it as "from". Empty array when none.
- "unexpectedDetails": concrete details the stated model of the world does NOT predict — a value that differs from what the model holds, or a state it says nothing about that the scene treats as settled. A striking detail the model already predicts is NOT unexpected. Empty array when none.
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

/**
 * Pure: MEASURED beats GUESSED. Overwrite exactly the dimensions the
 * deterministic prediction-error scorer actually measured; every other
 * dimension keeps the model's number.
 *
 * A dimension the scorer left UNDEFINED is not overwritten with 0 — an
 * unknown baseline is not a confident "no contradiction", and silently
 * zeroing it would be worse than the guess it replaced. The scene keeps
 * the guess and the scorerVersion composite says both producers were in
 * play, so a later reader can tell measured from guessed by re-running
 * the scorer against the stamped baselineRef.
 */
export function mergePredictionError(
  guessed: SceneMemoryValueLlm,
  measured: ScenePredictionError,
): SceneMemoryValueLlm {
  const merged: SceneMemoryValueLlm = { ...guessed };
  if (measured.contradiction !== undefined) merged.contradiction = clamp01(measured.contradiction);
  if (measured.stateChange !== undefined) merged.stateChange = clamp01(measured.stateChange);
  if (measured.identity !== undefined) merged.identity = clamp01(measured.identity);
  return merged;
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
  /** Projected ONLY under SCENES_PREDICTION_BASELINE (0055/0117 scope). */
  userId?: unknown;
  userIds?: unknown;
}

/** Per-scene expectation snapshot, or null when the scene has none. */
interface ScenePrediction {
  beliefs: BaselineBelief[];
  selfSubjects: ReadonlySet<string>;
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
  // Fifth is the platform's entity resolution, @Optional (the module-doc
  // idiom): positionally-constructed unit fixtures stay valid and the
  // SCENES_ENTITY_LINKS leg degrades to "resolve nothing" when it is not
  // wired, exactly as it does when a mention matches nothing.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly episodes: EpisodeReadStoreService,
    private readonly versions: SceneVersionService,
    @Optional() private readonly entities?: EntityUpsertService,
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
    // the idempotency key for the skip below. The prediction flag is
    // resolved here too (the Drift-3 contract) so a mid-run flip can never
    // mix prompt versions inside one enriched world.
    const { version } = this.versions.resolve();
    const predictionOn = scenePredictionBaselineEnabled();
    // Resolved ONCE per run for the same Drift-3 reason: a mid-run flip
    // must not leave half the world linked and half not.
    const entityLinksOn = sceneEntityLinksEnabled();
    const enrichmentVersion = sceneEnrichmentVersion(this.model, predictionOn);
    await this.surreal.withCompany(companyId, async (db) => {
      // The scope columns are projected ONLY when a leg actually needs
      // them — the prediction baseline's #387 fence, or the entity-link
      // fence, which reads the same single-user stamp. With BOTH off the
      // SELECT is byte-identical (pinned by unit test).
      const needsScope = predictionOn || entityLinksOn;
      const [scenes] = await db.query<[SceneHead[]]>(
        `SELECT id, conversationIds, enrichmentVersion${needsScope ? ', userId, userIds' : ''} FROM memory_episode
          WHERE segmenterVersion = $v` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      const all = scenes ?? [];
      result.scenes = all.length;
      // Idempotent skip: a scene already carrying the current
      // prompt|scorer|model revision needs no call — and, resolved BEFORE
      // the baseline read, no belief query either.
      const pending: SceneHead[] = [];
      for (const scene of all) {
        if (scene.enrichmentVersion === enrichmentVersion) {
          result.skipped += 1;
          this.logger.debug(
            `scene enrichment skipped ${String(scene.id)}: already at ${enrichmentVersion}`,
          );
        } else pending.push(scene);
      }
      // ONE bounded belief read per run, fenced to the users whose scenes
      // pass #387. Flag off (or nothing to enrich) ⇒ zero extra queries.
      const beliefsByUser =
        predictionOn && pending.length > 0
          ? await loadActiveBeliefBaseline(db, this.baselineUserIds(pending))
          : new Map<string, BaselineBelief[]>();
      // One raw-turn read per conversation, shared across its scenes.
      const turnCache = new Map<string, Map<string, SceneTurnRow>>();
      for (const scene of pending) {
        try {
          const ok = await this.enrichScene({
            db,
            scene,
            turnCache,
            enrichmentVersion,
            predictionOn,
            entityLinksOn,
            beliefsByUser,
          });
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

  /**
   * The distinct users whose beliefs this run may read: ONLY scenes that
   * pass the #387 single-user fence contribute one. A mixed-user,
   * tenant-global or legacy (pre-0117 userIds) scene contributes nothing
   * and later gets NO baseline — never a shared or foreign one.
   */
  private baselineUserIds(scenes: readonly SceneHead[]): string[] {
    const users = new Set<string>();
    for (const scene of scenes) {
      const userId = sceneSingleUser(scene);
      if (userId !== null) users.add(userId);
    }
    return [...users];
  }

  /** One scene: transcript → ONE structured call → validated UPDATE. */
  private async enrichScene({
    db,
    scene,
    turnCache,
    enrichmentVersion,
    predictionOn,
    entityLinksOn,
    beliefsByUser,
  }: {
    db: EpisodeDb;
    scene: SceneHead;
    turnCache: Map<string, Map<string, SceneTurnRow>>;
    enrichmentVersion: string;
    predictionOn: boolean;
    entityLinksOn: boolean;
    beliefsByUser: ReadonlyMap<string, BaselineBelief[]>;
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
    // THE EXPECTATION SNAPSHOT — taken BEFORE the scene is scored, so
    // "surprising" can mean "deviates from what we believed" instead of
    // "vivid". Null with the flag off, and null for any scene that fails
    // the #387 single-user fence (never scored against foreign beliefs).
    const prediction: ScenePrediction | null = predictionOn
      ? this.sceneExpectation({ scene, memberTurns, transcript, beliefsByUser })
      : null;
    const enrichment = await this.callModel(transcript, prediction);
    if (!enrichment) {
      this.logger.warn(
        `scene enrichment reply malformed for ${String(scene.id)} — scene keeps its deterministic gist`,
      );
      return false;
    }

    // MEASURED over GUESSED: the deterministic scorer (no model call) is
    // the producer of contradiction / stateChange / identity whenever it
    // can measure them; the rest of the vector stays the model's.
    const measured: ScenePredictionError =
      prediction === null
        ? {}
        : scorePredictionError({
            baseline: prediction.beliefs,
            stateDeltas: enrichment.stateDeltas,
            memberTurnCount: memberTurns.length,
            selfSubjects: prediction.selfSubjects,
          });

    // The 0106 semantic backlinks (SCENES_ENTITY_LINKS): free-text
    // mentions → knowledge_entity RECORD refs, resolve-only. null with the
    // flag off, and the SET clause below is then byte-identical.
    const entityIds = entityLinksOn
      ? await this.resolveEntityLinks(db, scene, enrichment.entityMentions)
      : null;

    // Single-record UPDATE by bound id — primary-key addressed, immune to
    // the 3.2.4 secondary-index planner bug by construction. Writes ONLY
    // the enrichment-revision siblings + stamps (0118) — plus, with the
    // baseline on, the 0106 FLEXIBLE `baselineRef` snapshot, and with
    // entity links on the 0106 `entityIds` refs: the composer's
    // deterministic gist / memoryValue stay immutable post-compose, and
    // gistPromptVersion is legacy-dead (superseded by enrichmentVersion).
    // Both optional clauses are APPENDED, in flag order, so each off-state
    // statement stays byte-identical (pinned by unit test).
    await db.query(
      `UPDATE $scene SET
         enrichedGist = $gist,
         enrichedMemoryValue = $memoryValue,
         stateDeltas = $stateDeltas,
         unexpectedDetails = $unexpectedDetails,
         enrichmentModel = $model,
         enrichmentVersion = $enrichmentVersion,
         enrichedAt = time::now()` +
        (prediction === null ? '' : `,\n         baselineRef = $baselineRef`) +
        (entityIds === null ? '' : `,\n         entityIds = $entityIds`),
      {
        scene: scene.id,
        gist: enrichment.gist,
        memoryValue: {
          ...(prediction === null
            ? enrichment.memoryValue
            : mergePredictionError(enrichment.memoryValue, measured)),
          scorerVersion: sceneScorerVersion(prediction !== null),
          scoredAt: new Date(),
        },
        stateDeltas: enrichment.stateDeltas,
        unexpectedDetails: enrichment.unexpectedDetails,
        model: this.model,
        enrichmentVersion,
        ...(prediction === null ? {} : { baselineRef: baselineRefPayload(prediction.beliefs) }),
        ...(entityIds === null ? {} : { entityIds }),
      },
    );
    return true;
  }

  /**
   * Resolve one scene's free-text mentions into knowledge_entity RECORD
   * refs (SCENES_ENTITY_LINKS). Returns the refs to write — possibly an
   * EMPTY array, which is a real answer ("we looked, nothing resolved")
   * and keeps the column stable across re-runs.
   *
   * RESOLVE-ONLY. Every lookup goes through
   * EntityUpsertService.resolveExistingByName, which never mints, never
   * stamps an alias and refuses ambiguous names — so an unresolvable
   * mention simply drops out. No resolver wired ⇒ nothing resolves, which
   * is the same graceful state.
   *
   * SCOPE — the #387 fence, reused verbatim. `sceneSingleUser` returns the
   * user only for a scene that is unambiguously ONE user's; a mixed-user,
   * tenant-global or legacy (pre-0117 userIds) scene yields null and then
   * resolves against TENANT-GLOBAL entities only. So a user-scoped scene
   * can reach its own user's entities and nobody else's, and a shared
   * scene can never carry a personal one.
   *
   * DEGRADE. One mention's failure warns and drops that mention; the
   * enrichment write it belongs to still lands.
   */
  private async resolveEntityLinks(
    db: EpisodeDb,
    scene: SceneHead,
    mentions: readonly string[],
  ): Promise<StringRecordId[]> {
    if (!this.entities) return [];
    const userId = sceneSingleUser(scene);
    const resolved: string[] = [];
    for (const name of selectSceneMentions(mentions)) {
      try {
        const entityId = await this.entities.resolveExistingByName(
          db as unknown as Surreal,
          { name },
          { userId: userId ?? undefined },
        );
        if (entityId !== null) resolved.push(entityId);
      } catch (e) {
        this.logger.warn(
          `scene entity link skipped for "${name}" on ${String(scene.id)}: ${(e as Error).message}`,
        );
      }
    }
    return stableEntityIds(resolved).map((id) => new StringRecordId(id));
  }

  /**
   * The per-scene expectation snapshot. Scenes failing the #387 fence get
   * an EMPTY baseline (not a foreign one) — they still take the v2 prompt
   * with an explicit "nothing is known" block, which is the honest thing
   * to show a model whose world we cannot scope.
   */
  private sceneExpectation({
    scene,
    memberTurns,
    transcript,
    beliefsByUser,
  }: {
    scene: SceneHead;
    memberTurns: SceneTurnRow[];
    transcript: string;
    beliefsByUser: ReadonlyMap<string, BaselineBelief[]>;
  }): ScenePrediction {
    const { userId, beliefs, selfSubjects } = sceneBaseline({
      scene,
      turns: memberTurns,
      transcript,
      beliefsByUser,
    });
    if (userId === null) {
      this.logger.debug(
        `scene prediction baseline empty for ${String(scene.id)}: not single-user — #387 fence`,
      );
    }
    return { beliefs, selfSubjects };
  }

  /** ONE strict-schema chat call (deriver-client idiom); null = degrade. */
  private async callModel(
    transcript: string,
    prediction: ScenePrediction | null,
  ): Promise<SceneEnrichment | null> {
    const res = await this.openai!.chat.completions.create({
      model: this.model,
      ...chatCallParams(this.model, { temperature: 0, visibleCap: ENRICH_VISIBLE_CAP }),
      messages: [
        {
          role: 'system',
          content: prediction === null ? SCENE_ENRICHMENT_SYSTEM : SCENE_ENRICHMENT_SYSTEM_V2,
        },
        {
          role: 'user',
          content:
            prediction === null
              ? `Scene transcript:\n${transcript}`
              : `${renderBaselineBlock(prediction.beliefs)}\n\nScene transcript:\n${transcript}`,
        },
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
