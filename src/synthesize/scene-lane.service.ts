import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { sceneUserGate, sceneVisibleToUser } from '../auth/segment-scope';
import { scopeFenceSql } from '../auth/scope-visibility';
import { buildLexMatchLeg } from './lex-leg';
import type { CitableScene } from './scene-citations';

/**
 * Scene lines per prompt (design constant, RETRIEVAL_SCENE_LANE —
 * deliberately NOT an env knob until the lane is measured; the
 * FRAGMENT_LANE_TOP_K / BELIEF_LANE_TOP_K idiom).
 *
 * WHY 2 AND NOT 3-4 LIKE THE SIBLING LANES: a scene is the LARGEST
 * retrieval unit in the system. A belief line is one distilled
 * proposition and a fragment line one caption/OCR excerpt, but a scene
 * gist summarizes a whole multi-turn stretch (up to SCENES_MAX_TURNS =
 * 40 turns), and the deterministic renderer packs a 160-char opener AND
 * a 160-char closer into it before the 600-char cap even bites. Two
 * scenes plus their notable-details clauses is already the token budget
 * of four fragment lines; a third would start displacing fact lines,
 * which the section budget exists to prevent.
 */
const SCENE_LANE_TOP_K = 2;
/** Rendered gist cap per line (the 600-char line-cap idiom). */
const SCENE_GIST_MAX_CHARS = 600;
/** Notable details rendered per line (the surprise payload is a list —
 *  bound it so one verbose enrichment cannot dominate the section). */
const SCENE_DETAILS_MAX = 3;
/** Per-detail character cap inside the notable-details clause. */
const SCENE_DETAIL_MAX_CHARS = 160;

/** memory_episode row columns the lane selects. */
interface SceneLaneRow {
  id: unknown;
  userId?: unknown;
  userIds?: unknown;
  sceneLabel?: unknown;
  gist?: unknown;
  unexpectedDetails?: unknown;
  occurredFrom?: Date | string;
  occurredTo?: Date | string;
  score?: number;
}

/** The lane's output: rendered lines + the rendered-set citation fence. */
export interface SceneLaneResult {
  /** One line per scene, occurredFrom-ascending, headed by the
   *  `[memory_episode:...]` id (citations ride the master flag). */
  lines: string[];
  /**
   * sceneId → rendered-scene info for resolveSceneCitations — EXACTLY
   * the scenes rendered into `lines` (the l3-citations turnsById
   * fence). Empty ⟺ `lines` is empty.
   */
  byId: Map<string, CitableScene>;
}

const EMPTY_RESULT: SceneLaneResult = { lines: [], byId: new Map() };

/**
 * Scene retrieval lane (RETRIEVAL_SCENE_LANE, profile.sceneLane) — the
 * FIRST serving reader of the episodic plane.
 *
 * Until this lane, `memory_episode` (migration 0106) was pure write-only
 * substrate: every reader was admin or maintenance (the composer, the
 * LLM enricher, the fact backlinker, the evidence linker, belief
 * promotion, version purge, reindex, the GDPR cascades). Scenes reached
 * answers only ONE HOP DOWN, as beliefs distilled out of their
 * stateDeltas. This lane REPEALS the 0106 shadow doctrine ("Nothing on
 * the serving path reads these tables") behind the default-off profile
 * field, and — because a serving reader finally exists — lets the scene
 * world be registered 'live' instead of 'built' (scene-composer.service
 * :128-130, the activation contract this lane fulfils).
 *
 * WHAT A SCENE ADDS THAT THE SIBLING LANES CANNOT. Facts answer "what
 * is true", beliefs "what is true NOW", verbatim segments "what was
 * said". A scene answers "what happened, together, when" — a coherent
 * multi-turn episode with a time span, a gist, and (once enriched) the
 * details that did NOT fit the model's expectation. That last payload,
 * `unexpectedDetails`, has had ZERO readers since the enricher started
 * writing it (scene-enricher.service.ts:362); this lane is its first
 * consumer, rendered as the line's "notable details" clause.
 *
 * RETRIEVAL. BM25 only, over the 0106 `scene_gist_search` FULLTEXT
 * index on `gist` — no dense leg. Two reasons, both deliberate:
 * `gistEmbedding` is populated ONLY when SCENES_TOPIC_BOUNDARY is on
 * (the composer's single paid step), so a dense leg would be write-dead
 * for the default world and silently useless; and a lane that needs no
 * embedder cannot fail on one. The leg is the V11 A2 `or_terms`
 * disjunction (buildLexMatchLeg), NOT a phrase-shaped `@1@ $query`: the
 * matches operator is AND-semantics over analyzed tokens, so a phrase
 * leg would require the WHOLE question to appear in the gist and leave
 * the lane empty for every natural question. Summed BM25 over the
 * bounded per-term disjunction ranks a gist covering more query words
 * higher.
 *
 * WORLD SELECTION — the registry IS the activation record. Scenes are
 * VERSIONED (segmenterVersion; competing segmenters coexist by design,
 * and SCENES_VERSION_FINGERPRINT forks a fresh id-space per config
 * change). The lane therefore does not guess a version string and does
 * not re-derive one from env — it reads the world the projection
 * registry marks 'live' for `name = 'scenes'`, which is exactly the
 * registry's own promise ("a registry row promises a queryable world",
 * projection-registry.service.ts). Consequences, all wanted:
 *   - a half-built or failed world ('building' / 'failed') NEVER serves;
 *   - an abandoned world demoted to 'residual' stops serving without a
 *     data migration;
 *   - no live row ⇒ the lane is EMPTY, fail-closed, with no scene query
 *     issued at all. An operator enabling the flag on a tenant whose
 *     scenes were built while it was off must re-run the composer once
 *     to promote the world (documented on the config-catalog entry).
 *
 * FENCE ORDER (composed per read):
 *   1. tenant  — SurrealService.withCompany scoping;
 *   2. user    — SCOPED-USER-ONLY, fail-closed: `userId === undefined`
 *      ⇒ the lane is EMPTY, no query issued. DELIBERATE TIGHTENING vs
 *      the four segment seams, where an unscoped M2M credential reads
 *      the tenant-global surface: a scene gist quotes verbatim member
 *      text, and blending it into an unscoped agent ANSWER is a
 *      cross-user disclosure no serving lane should make silently (the
 *      belief lane's D4 precedent). Scoped: the 0117 per-member gate
 *      (sceneUserGate) — own rows, plus userId-NONE rows whose
 *      persisted `userIds` is [] or CONTAINS the caller, FAILING CLOSED
 *      on `userIds IS NONE`. That is verbatim the read contract
 *      scene-segmentation.ts:235-240 wrote for this lane before it
 *      existed;
 *   3. PII     — `piiClass IS NONE` unless the caller holds
 *      brain:read_pii (the segment-lane text-PII idiom; memory_episode
 *      folds piiClass from its member turns);
 *   4. scope tags — scopeFenceSql(userId), the 0093 fence that ANDs
 *      alongside the userId filter (inert when SCOPE_TAGS_ENABLED is
 *      off, and can only ever narrow);
 *   5. world   — `segmenterVersion = <the registry's live version>`;
 *   6. JS re-check — sceneVisibleToUser(row, userId) fail-closed (the
 *      read-API doctrine: a blank/missing stamp is visible to NO ONE);
 *   7. cap at SCENE_LANE_TOP_K, sort by occurredFrom ascending;
 *   8. any error degrades to an empty section, never fails the answer.
 *
 * Same contracts as the sibling lanes: activation comes from the
 * caller-resolved profile field (profile.sceneLane, resolved ONCE per
 * request by the orchestrator) — this service reads no env (S5.2).
 */
@Injectable()
export class SceneLaneService {
  private readonly logger = new Logger(SceneLaneService.name);

  constructor(private readonly surreal: SurrealService) {}

  async sceneLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → the lane is EMPTY
     *  (fence 2 — scoped-user-only, see the class doc). */
    userId?: string | undefined;
  }): Promise<SceneLaneResult> {
    // Fence 2: an unscoped request serves NO scenes — checked before any
    // IO so the off-path issues zero queries.
    if (opts.userId === undefined) return EMPTY_RESULT;
    const userId = opts.userId;
    const fetchK = Math.max(SCENE_LANE_TOP_K * 3, 6);
    // Fence 3: text PII (the segment-lane idiom).
    const piiGate = opts.callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
    // Fence 2 (SQL half) + fence 4.
    const gate = sceneUserGate(userId);
    const scope = scopeFenceSql(userId);
    try {
      const rows = await this.surreal.withCompany(opts.companyId, async (db) => {
        // Fence 5: the world the registry marks LIVE. Fail-closed —
        // without one, no scene query is issued at all.
        const [worlds] = await db.query<[string[]]>(
          `SELECT VALUE version FROM projection
            WHERE name = 'scenes' AND status = 'live'
            ORDER BY finishedAt DESC
            LIMIT 1`,
        );
        const world = (worlds ?? [])[0];
        if (typeof world !== 'string' || world === '') return [];
        // The or_terms disjunctive BM25 leg (see the class doc) —
        // composed per request over the caller's query text.
        const lex = buildLexMatchLeg({
          fields: ['gist'],
          topic: opts.query,
          mode: 'or_terms',
        });
        const [hits] = await db.query<[SceneLaneRow[]]>(
          `SELECT id, userId, userIds, sceneLabel, gist, unexpectedDetails,
                    occurredFrom, occurredTo, ${lex.score} AS score
               FROM memory_episode
              WHERE ${lex.where}
                AND segmenterVersion = $world
                ${piiGate} ${gate.clause} ${scope.clause}
              ORDER BY score DESC
              LIMIT $k`,
          { ...lex.params, ...gate.params, ...scope.params, world, k: fetchK },
        );
        return hits ?? [];
      });
      if (rows.length === 0) return EMPTY_RESULT;
      return this.render(rows, userId);
    } catch (e) {
      // Fence 8: degrade to an empty section, never fail the answer.
      this.logger.warn(`scene lane failed (companyId=${opts.companyId}): ${(e as Error).message}`);
      return EMPTY_RESULT;
    }
  }

  /**
   * One line per scene, occurredFrom-ascending, capped at
   * SCENE_LANE_TOP_K. Line shape:
   *   `[memory_episode:...] (<span>) <gist>`
   * and, when the scene carries `unexpectedDetails`:
   *   `[memory_episode:...] (<span>) <gist> — notable details: a; b`
   * where `<span>` is the scene's UTC time span in the 0106 renderer's
   * own convention — `YYYY-MM-DD HH:mm–HH:mm UTC` within one day,
   * `YYYY-MM-DD HH:mm–YYYY-MM-DD HH:mm UTC` across days.
   *
   * This is the ONE render site — the generator and the verifier read
   * these same lines (three-consumer parity by construction, the belief
   * lane's contract). The id header renders UNCONDITIONALLY: scene
   * citations ride the master flag (no separate switch; see
   * scene-citations.ts). Fence 6 (sceneVisibleToUser) re-applies here
   * fail-closed — an out-of-contract row the SQL fence let through
   * never renders.
   */
  private render(rows: SceneLaneRow[], userId: string): SceneLaneResult {
    const kept: SceneLaneRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      // Fence 6: JS re-check of the user fence (the read-API doctrine).
      if (!sceneVisibleToUser(row, userId)) continue;
      const sceneId = row.id === undefined ? '' : String(row.id);
      const gist = typeof row.gist === 'string' ? row.gist : '';
      if (!sceneId || !gist.trim() || seen.has(sceneId)) continue;
      seen.add(sceneId);
      kept.push(row);
      if (kept.length >= SCENE_LANE_TOP_K) break;
    }
    const ordered = kept.slice().sort((a, b) => toMs(a.occurredFrom) - toMs(b.occurredFrom));
    const lines: string[] = [];
    const byId = new Map<string, CitableScene>();
    for (const row of ordered) {
      const sceneId = String(row.id);
      const excerpt = String(row.gist).slice(0, SCENE_GIST_MAX_CHARS);
      const span = renderSpan(row.occurredFrom, row.occurredTo);
      const details = renderDetails(row.unexpectedDetails);
      lines.push(`[${sceneId}]${span ? ` (${span})` : ''} ${excerpt}${details}`);
      byId.set(sceneId, {
        sceneId,
        sceneLabel: typeof row.sceneLabel === 'string' ? row.sceneLabel : '',
        excerpt,
        ...(row.occurredFrom !== undefined ? { occurredAt: isoInstant(row.occurredFrom) } : {}),
      });
    }
    return { lines, byId };
  }
}

function toMs(v: Date | string | undefined): number {
  if (v === undefined) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

function isoInstant(v: Date | string | undefined): string {
  return new Date(toMs(v)).toISOString();
}

/**
 * The scene's UTC time span, in migration 0106's own gist convention
 * (`renderSceneGist`): same-day spans collapse the second date.
 * Unparseable/absent `occurredFrom` ⇒ '' (the line renders without the
 * parenthesized span rather than with a bogus epoch date).
 */
function renderSpan(from: Date | string | undefined, to: Date | string | undefined): string {
  const fromMs = toMs(from);
  if (from === undefined || fromMs === 0) return '';
  const fromIso = new Date(fromMs).toISOString();
  const day = fromIso.slice(0, 10);
  const start = fromIso.slice(11, 16);
  const toMsValue = toMs(to);
  if (to === undefined || toMsValue === 0) return `${day} ${start} UTC`;
  const toIso = new Date(toMsValue).toISOString();
  const endDay = toIso.slice(0, 10);
  const end = toIso.slice(11, 16);
  return endDay === day ? `${day} ${start}–${end} UTC` : `${day} ${start}–${endDay} ${end} UTC`;
}

/**
 * The 0106 surprise payload as a rendered clause — this lane is
 * `unexpectedDetails`' FIRST consumer. Non-string and blank entries are
 * dropped, whitespace runs collapse (the segmenter's trim convention),
 * each entry is capped, and at most SCENE_DETAILS_MAX render. Nothing
 * usable ⇒ '' (the line is byte-identical to an unenriched scene's).
 */
function renderDetails(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const details: string[] = [];
  for (const entry of raw) {
    if (details.length >= SCENE_DETAILS_MAX) break;
    if (typeof entry !== 'string') continue;
    const text = entry.replace(/\s+/g, ' ').trim().slice(0, SCENE_DETAIL_MAX_CHARS);
    if (text) details.push(text);
  }
  return details.length > 0 ? ` — notable details: ${details.join('; ')}` : '';
}
