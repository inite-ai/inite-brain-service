import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { RecordId, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import {
  sceneBeliefLlmSynthesisEnabled,
  sceneBeliefMinScenes,
  sceneBeliefPromotionEnabled,
} from '../common/scene-flags';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildSupportEdgeBatches } from '../common/support-edges';
import { SceneVersionService } from './scene-version';

/**
 * Belief promotion (Belief-A, SCENES_BELIEF_PROMOTION — default off):
 * folds ENRICHED scenes of the CURRENT effective segmenter version
 * (SceneVersionService.resolve, the Drift-3 once-per-run contract) into
 * the shadow semantic_belief substrate (migration 0120) — the
 * MemoryEpisode[] -> SemanticBelief distillation. Triggered ONLY from
 * the scenes admin surface (POST /v1/admin/maintenance/scenes/beliefs).
 *
 * FOLD. Each enriched scene's stateDeltas ({subject, field, from, to} —
 * enrichment-owned, 0118) are grouped by (userId, subject, field) —
 * free-text keys, deliberately unresolved (the 0120 header's
 * SemanticBelief/Claim separation). Within a group, contributions are
 * ordered by scene time (occurredTo, then scene id — deterministic);
 * the LATEST value wins and earlier values are its history, exactly like
 * sequential state transitions. gist/memoryValue fold in as provenance
 * and confidence signal (enrichedMemoryValue.explicitness), never as
 * keys.
 *
 * CONFLICT GUARD (built-in, no flag): a group whose latest timestamp is
 * shared by two DIFFERENT values has no deterministic winner — the whole
 * (subject, field) group is SKIPPED LOUDLY with a warn. Same for a
 * batch whose winner is not newer than the active belief's validFrom
 * (stale/ambiguous re-promotion — skipped loudly, never flip-flopped).
 *
 * REVISIONS: supersede chain in code, NEVER in-place for values. A new
 * value creates revision N+1 and stamps the old row status='superseded'
 * + validUntil + supersededBy; in-place UPDATE is allowed ONLY for the
 * corroboration counters (sourceSceneIds / conversationIds /
 * corroborationCount / conversationCount / updatedAt). fn::resolve_fact
 * reuse was REJECTED (claim-specific — 0120 header).
 *
 * PROVENANCE: sourceSceneIds is the inline canonical trail (survives
 * flag-off); when PROVENANCE_SUPPORT_EDGES is on, the pass additionally
 * mirrors it into memory_support (supported_by belief->scene) and marks
 * revisions (contradicted_by old->new, derived_from new->old), writer
 * 'belief_promotion' — INSERT RELATION IGNORE, replay-idempotent.
 *
 * SCENE CONTRACTS (0106, finally fulfilled): consumed scenes get
 * consolidatedInto ∪= [belief] (idempotent array::union; column widened
 * to generic records in 0120) and — on a revision ONLY — baselineRef =
 * {belief, revision, value, stampedAt}: the belief revision the delta
 * was applied against. Revision 1 has no baseline (baselineRef stays
 * NONE).
 *
 * #387 USER FENCE (fail-closed): a belief inherits the SINGLE-user
 * scope of its scenes. A scene whose userIds (0117) is missing (legacy,
 * pre-0117), empty (tenant-global), or has more than one member — or
 * disagrees with the folded userId stamp — is SKIPPED LOUDLY.
 *
 * IDEMPOTENT: deterministic record ids over (userId|subject|field|
 * revision) + INSERT IGNORE + array::union stamps ⇒ a re-run over the
 * same scene world converges without duplicates; a same-value re-fold
 * is a pure corroboration no-op.
 *
 * OFF = ZERO QUERIES: with SCENES_BELIEF_PROMOTION off the controller
 * 404s AND this service returns before touching the version resolver or
 * the database (pinned by unit test) — byte-identical prod.
 *
 * TESTABILITY: `openai` is the enricher's stub-injectable idiom — a
 * plain private field holding only the chat.completions.create surface;
 * tests swap it for a scripted stub, NO paid call ever happens in CI.
 * The deterministic template fold works with no client at all.
 */

/** Promoter identity — composed with the effective scene world below. */
export const BELIEF_PROMOTER_VERSION = 'belief-promotion-v1';

/**
 * Pure: the readable promoter|world composite stamped on belief rows and
 * support edges (the enricher's readable-composite idiom — NOT hashed).
 */
export function beliefPromoterVersion(sceneVersion: string): string {
  return `${BELIEF_PROMOTER_VERSION}|${sceneVersion}`;
}

/** Belts against runaway payloads (the enricher's cap discipline). */
const STATEMENT_MAX_CHARS = 500;
const SYNTHESIS_VISIBLE_CAP = 400;

/** Confidence fold constants: explicitness mean + corroboration bonus. */
const DEFAULT_EXPLICITNESS = 0.5;
const CORROBORATION_BONUS = 0.05;
const CONFIDENCE_CAP = 0.95;
const CONFIDENCE_FLOOR = 0.05;

export const BELIEF_SYNTHESIS_SYSTEM = `You phrase ONE remembered belief — a (subject, attribute, value) state a user's conversations established — as a single natural sentence. Output strictly the JSON schema: "statement": one concise declarative sentence stating the belief content itself (never meta-language like "the user said"). Include the previous value only when one is given.`;

/** Scene head as selected by the promotion query (validated in JS). */
export interface PromotableSceneHead {
  id: unknown;
  userId?: unknown;
  userIds?: unknown;
  conversationIds?: unknown;
  occurredTo?: unknown;
  stateDeltas?: unknown;
  /** enrichedMemoryValue.explicitness projection (confidence signal). */
  explicitness?: unknown;
}

/**
 * Pure: the single user a scene's beliefs may inherit, or null when the
 * scene must be skipped fail-closed (#387): userIds missing (legacy),
 * empty (tenant-global), longer than one (mixed group), or disagreeing
 * with the folded userId stamp.
 */
export function sceneSingleUser(scene: PromotableSceneHead): string | null {
  const userIds = scene.userIds;
  if (!Array.isArray(userIds) || userIds.length !== 1) return null;
  const only = userIds[0];
  if (typeof only !== 'string' || only === '') return null;
  if (scene.userId !== only) return null;
  return only;
}

/** One delta occurrence, normalized for the fold. */
export interface BeliefContribution {
  sceneId: string;
  conversationId: string;
  /** Scene occurredTo as epoch ms — the fold's ordering axis. */
  occurredAt: number;
  value: string;
  priorValue: string;
  explicitness: number;
}

/** One promotable (userId, subject, field) verdict out of the fold. */
export interface FoldedBelief {
  userId: string;
  subject: string;
  field: string;
  value: string;
  /** The winner delta's `from` ('' when unknown). */
  priorValue: string;
  validFrom: Date;
  /** Scenes contributing the WINNING value (distinct, emission order). */
  sceneIds: string[];
  /** Distinct conversations behind those scenes — the floor unit. */
  conversationIds: string[];
  confidence: number;
}

export interface BeliefFold {
  folded: FoldedBelief[];
  /** Groups the conflict guard refused (ambiguous latest value). */
  conflicts: Array<{ userId: string; subject: string; field: string; values: string[] }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Pure: group eligible scenes' stateDeltas by (userId, subject, field)
 * and fold each group to one verdict (latest value wins; scenes ordered
 * by occurredTo then scene id, so the fold is deterministic). Groups
 * whose latest timestamp carries two different values are returned as
 * conflicts (the built-in guard) — never half-promoted.
 */
export function foldBeliefGroups(
  scenes: ReadonlyArray<{ scene: PromotableSceneHead; userId: string }>,
): BeliefFold {
  const groups = new Map<
    string,
    { userId: string; subject: string; field: string; contributions: BeliefContribution[] }
  >();
  for (const { scene, userId } of scenes) {
    const sceneId = String(scene.id);
    const conversationId = Array.isArray(scene.conversationIds)
      ? str(scene.conversationIds[0])
      : '';
    // WS-driver datetimes arrive as Date instances; e2e/unit fixtures may
    // hand ISO strings — accept both, never String(Date) (query_arc lesson).
    const occurredAt =
      scene.occurredTo instanceof Date
        ? scene.occurredTo.getTime()
        : new Date(String(scene.occurredTo ?? '')).getTime();
    if (!Number.isFinite(occurredAt)) continue; // unordered scene: unusable
    const explicitnessRaw = scene.explicitness;
    const explicitness =
      typeof explicitnessRaw === 'number' && Number.isFinite(explicitnessRaw)
        ? Math.min(1, Math.max(0, explicitnessRaw))
        : DEFAULT_EXPLICITNESS;
    for (const delta of Array.isArray(scene.stateDeltas) ? scene.stateDeltas : []) {
      if (typeof delta !== 'object' || delta === null) continue;
      const d = delta as Record<string, unknown>;
      const subject = str(d.subject);
      const field = str(d.field);
      const value = str(d.to);
      // A delta without a landing value holds nothing promotable.
      if (subject === '' || field === '' || value === '') continue;
      const key = `${userId}\x00${subject}\x00${field}`;
      let group = groups.get(key);
      if (!group) {
        group = { userId, subject, field, contributions: [] };
        groups.set(key, group);
      }
      group.contributions.push({
        sceneId,
        conversationId,
        occurredAt,
        value,
        priorValue: str(d.from),
        explicitness,
      });
    }
  }

  const fold: BeliefFold = { folded: [], conflicts: [] };
  for (const group of groups.values()) {
    const ordered = [...group.contributions].sort(
      (a, b) => a.occurredAt - b.occurredAt || a.sceneId.localeCompare(b.sceneId),
    );
    const winner = ordered[ordered.length - 1]!;
    // Conflict guard: a DIFFERENT value at the winning timestamp means
    // the batch has no deterministic latest state.
    const ambiguous = ordered.some(
      (c) => c.occurredAt === winner.occurredAt && c.value !== winner.value,
    );
    if (ambiguous) {
      fold.conflicts.push({
        userId: group.userId,
        subject: group.subject,
        field: group.field,
        values: [...new Set(ordered.map((c) => c.value))].sort(),
      });
      continue;
    }
    const corroborating = ordered.filter((c) => c.value === winner.value);
    const sceneIds = [...new Set(corroborating.map((c) => c.sceneId))];
    const conversationIds = [
      ...new Set(corroborating.map((c) => c.conversationId).filter((c) => c !== '')),
    ];
    const meanExplicitness =
      corroborating.reduce((sum, c) => sum + c.explicitness, 0) / corroborating.length;
    const confidence = Math.min(
      CONFIDENCE_CAP,
      Math.max(
        CONFIDENCE_FLOOR,
        meanExplicitness + CORROBORATION_BONUS * Math.max(0, conversationIds.length - 1),
      ),
    );
    fold.folded.push({
      userId: group.userId,
      subject: group.subject,
      field: group.field,
      value: winner.value,
      priorValue: winner.priorValue,
      validFrom: new Date(winner.occurredAt),
      sceneIds,
      conversationIds,
      confidence: Math.round(confidence * 10000) / 10000,
    });
  }
  // Deterministic emission order (stable logs, stable tests).
  fold.folded.sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      a.subject.localeCompare(b.subject) ||
      a.field.localeCompare(b.field),
  );
  return fold;
}

/** Pure: the deterministic statement template (works with no LLM). */
export function renderBeliefStatement(f: {
  subject: string;
  field: string;
  value: string;
  priorValue: string;
}): string {
  const base = `${f.subject} — ${f.field}: ${f.value}`;
  const withPrior =
    f.priorValue !== '' && f.priorValue !== f.value ? `${base} (was: ${f.priorValue})` : base;
  return withPrior.slice(0, STATEMENT_MAX_CHARS);
}

/**
 * Pure: deterministic record-id tail over (userId|subject|field|
 * revision) — the composer's sceneIdTail idiom. Paired with INSERT
 * IGNORE it makes every create replay-idempotent, and it enforces
 * (userId, subject, field, revision) uniqueness in CODE — a compound
 * UNIQUE index is exactly the 3.2.4 planner trap 0120 avoids.
 */
export function beliefIdTail(
  key: { userId: string; subject: string; field: string },
  revision: number,
): string {
  return createHash('sha256')
    .update(`${key.userId}\x00${key.subject}\x00${key.field}\x00${revision}`)
    .digest('hex')
    .slice(0, 24);
}

export interface BeliefPromotionResult {
  /** Enriched scenes of the current version seen by the pass. */
  scenes: number;
  /** Scenes that passed the #387 single-user fence into the fold. */
  eligibleScenes: number;
  skippedMixedUser: number;
  /** (subject, field) groups the conflict guard refused. */
  skippedConflict: number;
  /** Groups below the SCENES_BELIEF_MIN_SCENES conversation floor. */
  skippedFloor: number;
  /** Groups whose winner was not newer than the active belief (stale). */
  skippedStale: number;
  beliefsCreated: number;
  beliefsCorroborated: number;
  beliefsRevised: number;
  /** memory_support rows written (0 unless PROVENANCE_SUPPORT_EDGES). */
  supportEdges: number;
}

/** Active-belief head read back for the upsert decision. */
interface ActiveBeliefRow {
  id: unknown;
  revision: number;
  value: string;
  validFrom: unknown;
  sourceSceneIds?: unknown;
  conversationIds?: unknown;
}

interface BeliefDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

/** The one client surface the synthesis uses (mock-swappable in tests). */
type ChatCompletionsClient = Pick<OpenAI, 'chat'>;

@Injectable()
export class BeliefPromotionService {
  private readonly logger = new Logger(BeliefPromotionService.name);
  /**
   * Nullable by contract (createOpenAiClient): no OPENAI_API_KEY ⇒ the
   * optional synthesis degrades to the template. Tests replace this
   * field with a scripted stub (mockBeliefSynthesisOpenAi) — the same
   * seam as SceneEnricherService.openai.
   */
  private readonly openai: ChatCompletionsClient | null;
  private readonly model: string;

  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly versions: SceneVersionService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = configService.get<string>(
      'SCENES_BELIEF_MODEL',
      configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Promote every enriched scene of the CURRENT segmenter version
   * (optionally one conversation's). Per-group problems degrade to a
   * loud skip — the pass never throws for one bad group.
   */
  async run(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<BeliefPromotionResult> {
    const result: BeliefPromotionResult = {
      scenes: 0,
      eligibleScenes: 0,
      skippedMixedUser: 0,
      skippedConflict: 0,
      skippedFloor: 0,
      skippedStale: 0,
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
      supportEdges: 0,
    };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not write belief rows past a disabled
    // flag. Off = ZERO queries (returns before the version resolver and
    // before any db handle) — pinned by unit test.
    if (!sceneBeliefPromotionEnabled()) return result;
    // Effective world + knobs resolved ONCE per run (the Drift-3
    // contract): a mid-run env flip can never mix worlds or floors.
    const { version } = this.versions.resolve();
    const promoterVersion = beliefPromoterVersion(version);
    const floor = sceneBeliefMinScenes();
    const edgesOn = supportEdgesEnabled();
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[PromotableSceneHead[]]>(
        `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      const eligible: Array<{ scene: PromotableSceneHead; userId: string }> = [];
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        const userId = sceneSingleUser(scene);
        if (userId === null) {
          // #387 fail-closed: mixed-user, tenant-global or legacy
          // (pre-0117 userIds) scenes never feed a belief.
          result.skippedMixedUser += 1;
          this.logger.warn(
            `belief promotion skipped scene ${String(scene.id)}: not single-user ` +
              `(userIds=${JSON.stringify(scene.userIds ?? null)}) — #387 fence`,
          );
          continue;
        }
        result.eligibleScenes += 1;
        eligible.push({ scene, userId });
      }

      const { folded, conflicts } = foldBeliefGroups(eligible);
      result.skippedConflict = conflicts.length;
      for (const c of conflicts) {
        this.logger.warn(
          `belief promotion conflict guard: (${c.subject}, ${c.field}) for user ${c.userId} ` +
            `has irreconcilable in-batch values [${c.values.join(' | ')}] — group skipped`,
        );
      }

      for (const belief of folded) {
        if (floor > 0 && belief.conversationIds.length < floor) {
          result.skippedFloor += 1;
          this.logger.debug(
            `belief promotion floor: (${belief.subject}, ${belief.field}) has ` +
              `${belief.conversationIds.length} conversation(s) < floor ${floor} — not promoted`,
          );
          continue;
        }
        await this.upsertBelief({ db, belief, promoterVersion, edgesOn, result });
      }
    });
    this.logger.log(
      `belief promotion pass: ${result.beliefsCreated} created, ` +
        `${result.beliefsCorroborated} corroborated, ${result.beliefsRevised} revised ` +
        `over ${result.eligibleScenes}/${result.scenes} scene(s) ` +
        `(mixedUser=${result.skippedMixedUser} conflict=${result.skippedConflict} ` +
        `floor=${result.skippedFloor} stale=${result.skippedStale} edges=${result.supportEdges})`,
    );
    return result;
  }

  /** One (userId, subject, field) verdict: create / corroborate / revise. */
  private async upsertBelief({
    db,
    belief,
    promoterVersion,
    edgesOn,
    result,
  }: {
    db: BeliefDb;
    belief: FoldedBelief;
    promoterVersion: string;
    edgesOn: boolean;
    result: BeliefPromotionResult;
  }): Promise<void> {
    const [actives] = await db.query<[ActiveBeliefRow[]]>(
      `SELECT id, revision, value, validFrom, sourceSceneIds, conversationIds
         FROM semantic_belief
        WHERE userId = $u AND subject = $s AND field = $f AND status = 'active'
        ORDER BY revision DESC`,
      { u: belief.userId, s: belief.subject, f: belief.field },
    );
    const head = (actives ?? [])[0];
    // Self-heal a crash window (revision created, supersede stamp lost):
    // every active row below the highest revision is stamped superseded.
    for (const dangling of (actives ?? []).slice(1)) {
      this.logger.warn(
        `belief promotion: repairing dangling active revision ${dangling.revision} ` +
          `of (${belief.subject}, ${belief.field})`,
      );
      await db.query(
        `UPDATE $id SET status = 'superseded', supersededBy = $winner,
                        validUntil = $until, updatedAt = time::now()`,
        {
          id: new StringRecordId(String(dangling.id)),
          winner: new StringRecordId(String(head!.id)),
          until: head!.validFrom,
        },
      );
    }

    if (!head) {
      await this.createRevision({ db, belief, revision: 1, promoterVersion });
      await this.stampScenes(db, belief.sceneIds, beliefRecordString(belief, 1));
      if (edgesOn) {
        result.supportEdges += await this.writeEdges(db, promoterVersion, [
          {
            kind: 'supported_by' as const,
            pairs: belief.sceneIds.map((s) => ({ in: beliefRecordString(belief, 1), out: s })),
          },
        ]);
      }
      result.beliefsCreated += 1;
      return;
    }

    const headId = String(head.id);
    // The WS driver returns datetimes as Date instances — never round-trip
    // through String(Date) (the query_arc lesson).
    const headValidFrom =
      head.validFrom instanceof Date
        ? head.validFrom.getTime()
        : new Date(String(head.validFrom)).getTime();

    if (head.value === belief.value) {
      // CORROBORATION — the only in-place update the substrate allows:
      // counters + provenance union, never value/statement/validFrom.
      const knownScenes = (Array.isArray(head.sourceSceneIds) ? head.sourceSceneIds : []).map(
        String,
      );
      const knownConvs = (Array.isArray(head.conversationIds) ? head.conversationIds : []).map(
        String,
      );
      const mergedScenes = [...new Set([...knownScenes, ...belief.sceneIds])];
      const mergedConvs = [...new Set([...knownConvs, ...belief.conversationIds])];
      const newScenes = belief.sceneIds.filter((s) => !knownScenes.includes(s));
      if (newScenes.length > 0) {
        await db.query(
          `UPDATE $id SET sourceSceneIds = $scenes, conversationIds = $convs,
                          corroborationCount = $n, conversationCount = $m,
                          updatedAt = time::now()`,
          {
            id: new StringRecordId(headId),
            scenes: mergedScenes.map((s) => new StringRecordId(s)),
            convs: mergedConvs,
            n: mergedScenes.length,
            m: mergedConvs.length,
          },
        );
        result.beliefsCorroborated += 1;
      }
      // Stamps + edges are replay-idempotent (array::union / INSERT
      // IGNORE) and always re-asserted so a crash between the belief
      // write and the stamps heals on the next run.
      await this.stampScenes(db, belief.sceneIds, headId);
      if (edgesOn) {
        result.supportEdges += await this.writeEdges(db, promoterVersion, [
          {
            kind: 'supported_by' as const,
            pairs: belief.sceneIds.map((s) => ({ in: headId, out: s })),
          },
        ]);
      }
      return;
    }

    // Stale/ambiguous batch: never revise BACKWARD in valid time — a
    // re-promotion of an older world must not flip-flop the chain.
    if (!Number.isFinite(headValidFrom) || belief.validFrom.getTime() <= headValidFrom) {
      result.skippedStale += 1;
      this.logger.warn(
        `belief promotion stale guard: (${belief.subject}, ${belief.field}) candidate ` +
          `'${belief.value}' at ${belief.validFrom.toISOString()} is not newer than the ` +
          `active revision ${head.revision} ('${head.value}') — group skipped`,
      );
      return;
    }

    // REVISION — supersede chain in code, never in-place: revision N+1
    // holds the new value; the displaced row gets status/validUntil/
    // supersededBy stamped. The ACTUAL displaced value beats the delta's
    // claimed `from` as priorValue.
    const revision = head.revision + 1;
    const newId = beliefRecordString(belief, revision);
    await this.createRevision({
      db,
      belief: { ...belief, priorValue: head.value },
      revision,
      promoterVersion,
    });
    await db.query(
      `UPDATE $id SET status = 'superseded', supersededBy = $new,
                      validUntil = $until, updatedAt = time::now()`,
      {
        id: new StringRecordId(headId),
        new: new StringRecordId(newId),
        until: belief.validFrom,
      },
    );
    await this.stampScenes(db, belief.sceneIds, newId);
    // The 0106 baselineRef contract: the belief revision the delta was
    // applied against (NONE for revision 1 — no baseline existed).
    await db.query(`UPDATE memory_episode SET baselineRef = $baseline WHERE id INSIDE $sceneIds`, {
      baseline: {
        belief: headId,
        revision: head.revision,
        value: head.value,
        stampedAt: new Date().toISOString(),
      },
      sceneIds: belief.sceneIds.map((s) => new StringRecordId(s)),
    });
    if (edgesOn) {
      result.supportEdges += await this.writeEdges(db, promoterVersion, [
        // Old belief is contradicted by the new one (the resolver's
        // loser->winner direction), and the new one derives from it.
        { kind: 'contradicted_by' as const, pairs: [{ in: headId, out: newId }] },
        { kind: 'derived_from' as const, pairs: [{ in: newId, out: headId }] },
        {
          kind: 'supported_by' as const,
          pairs: belief.sceneIds.map((s) => ({ in: newId, out: s })),
        },
      ]);
    }
    result.beliefsRevised += 1;
  }

  /** INSERT IGNORE one revision row (deterministic id — replay-safe). */
  private async createRevision({
    db,
    belief,
    revision,
    promoterVersion,
  }: {
    db: BeliefDb;
    belief: FoldedBelief;
    revision: number;
    promoterVersion: string;
  }): Promise<void> {
    const statement = await this.composeStatement(belief);
    await db.query(`INSERT IGNORE INTO semantic_belief $rows`, {
      rows: [
        {
          id: new RecordId('semantic_belief', beliefIdTail(belief, revision)),
          userId: belief.userId,
          subject: belief.subject,
          field: belief.field,
          value: belief.value,
          ...(belief.priorValue !== '' ? { priorValue: belief.priorValue } : {}),
          statement: statement.text,
          statementSource: statement.source,
          confidence: belief.confidence,
          revision,
          status: 'active',
          validFrom: belief.validFrom,
          sourceSceneIds: belief.sceneIds.map((s) => new StringRecordId(s)),
          conversationIds: belief.conversationIds,
          corroborationCount: belief.sceneIds.length,
          conversationCount: belief.conversationIds.length,
          promoterVersion,
        },
      ],
    });
  }

  /** consolidatedInto ∪= [belief] on the consumed scenes (idempotent). */
  private async stampScenes(db: BeliefDb, sceneIds: string[], beliefId: string): Promise<void> {
    if (sceneIds.length === 0) return;
    // Primary-key addressed (WHERE id INSIDE explicit list) — immune by
    // construction to the 3.2.4 secondary-index planner bug class.
    await db.query(
      `UPDATE memory_episode
          SET consolidatedInto = array::union(consolidatedInto ?? [], [$belief])
        WHERE id INSIDE $sceneIds`,
      {
        belief: new StringRecordId(beliefId),
        sceneIds: sceneIds.map((s) => new StringRecordId(s)),
      },
    );
  }

  /** Shape-validated, deduped, capped, replay-idempotent edge writes. */
  private async writeEdges(
    db: BeliefDb,
    promoterVersion: string,
    specs: Array<{
      kind: 'supported_by' | 'contradicted_by' | 'derived_from';
      pairs: Array<{ in: string; out: string }>;
    }>,
  ): Promise<number> {
    let written = 0;
    for (const spec of specs) {
      const { batches, skipped } = buildSupportEdgeBatches({
        kind: spec.kind,
        writer: 'belief_promotion',
        writerVersion: promoterVersion,
        pairs: spec.pairs,
      });
      if (skipped > 0) {
        this.logger.warn(
          `belief promotion: ${skipped} malformed ${spec.kind} support-edge pair(s) skipped`,
        );
      }
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
    }
    return written;
  }

  /** Statement text: deterministic template, optionally LLM-phrased. */
  private async composeStatement(
    belief: FoldedBelief,
  ): Promise<{ text: string; source: 'template' | 'llm' }> {
    const template = renderBeliefStatement(belief);
    if (!sceneBeliefLlmSynthesisEnabled()) return { text: template, source: 'template' };
    if (!this.openai) {
      this.logger.warn('belief statement synthesis skipped: no OPENAI_API_KEY configured');
      return { text: template, source: 'template' };
    }
    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        ...chatCallParams(this.model, { temperature: 0, visibleCap: SYNTHESIS_VISIBLE_CAP }),
        messages: [
          { role: 'system', content: BELIEF_SYNTHESIS_SYSTEM },
          {
            role: 'user',
            content:
              `subject: ${belief.subject}\nattribute: ${belief.field}\nvalue: ${belief.value}` +
              (belief.priorValue !== '' && belief.priorValue !== belief.value
                ? `\nprevious value: ${belief.priorValue}`
                : ''),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'belief_statement',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { statement: { type: 'string' } },
              required: ['statement'],
            },
          },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) return { text: template, source: 'template' };
      const parsed: unknown = JSON.parse(content);
      const raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).statement
          : undefined;
      const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (text === '') return { text: template, source: 'template' };
      return { text: text.slice(0, STATEMENT_MAX_CHARS), source: 'llm' };
    } catch (e) {
      // Degrade, never fail: the deterministic fold must not depend on
      // the optional synthesis (transport error, malformed reply, ...).
      this.logger.warn(`belief statement synthesis degraded to template: ${(e as Error).message}`);
      return { text: template, source: 'template' };
    }
  }
}

/** Full record-id string for a folded belief at a given revision. */
function beliefRecordString(
  belief: Pick<FoldedBelief, 'userId' | 'subject' | 'field'>,
  revision: number,
): string {
  return `semantic_belief:${beliefIdTail(belief, revision)}`;
}
