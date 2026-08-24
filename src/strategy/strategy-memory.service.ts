import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { envFlagEnabled } from '../common/env-validation';
import { cosineSimilarity } from '../common/vector-math';
import {
  isVerifiedOutcome,
  renderTrajectorySuffix,
  type ToolStep,
  type VerifiedOutcome,
} from './trajectory-digest';

/**
 * StrategyMemoryService — the ReasoningBank-shape strategy store
 * (docs/roadmap/sota-gap-build-2026-08.md G4, migration 0092).
 *
 * Items are procedural "how to answer" lessons (situation
 * preconditions + a 2-5 sentence why/when strategy, polarity
 * do|avoid), distilled from judged post-mortems. They are ADVICE,
 * never evidence: the table is separate from every fact lane by
 * design, so fact retrieval structurally cannot return a strategy row
 * and a strategy row can never be cited.
 *
 * Retrieval contract (ReasoningBank k-sensitivity, validated
 * externally: WebArena 49.7% at k=1 vs 44.4% at k=4 — more
 * strategies actively hurt): k defaults to 1 and is HARD-capped at 2,
 * with a similarity floor (STRATEGY_SIMILARITY_FLOOR, default 0.4)
 * so an irrelevant best-match serves nothing. Only status='active'
 * items are served. Cosine scoring is JS-side over a small N — the
 * CommunityService / ProceduralMemoryService.match idiom; strategy
 * memory is a curated distillate (O(10¹-10²) rows), not a fact
 * firehose, so no HNSW index.
 */

export type StrategyPolarity = 'do' | 'avoid';
export type StrategyStatus = 'candidate' | 'active' | 'deprecated';
export type StrategyScope = 'tenant' | 'global';

/** Vote counters + provenance (Memp/ExpeL lifecycle inputs). */
export interface StrategyEvidence extends Record<string, unknown> {
  source?: string;
  runIds?: string[];
  nSupport?: number;
  nContradict?: number;
  lastValidatedAt?: string | undefined;
}

export interface StrategyItem {
  strategyId: string;
  companyId: string;
  title: string;
  situation: string;
  strategy: string;
  polarity: StrategyPolarity;
  status: StrategyStatus;
  evidence: StrategyEvidence;
  scope: StrategyScope;
  createdAt: string;
  updatedAt: string;
  /**
   * Experience-memory extension (0098, STRATEGY_TRAJECTORIES_ENABLED):
   * the concrete tool path + verified outcome distilled alongside the
   * advice. Present ONLY when the trajectories flag is on AND the row
   * carries one — the read path does not even select these columns when
   * the flag is off, so an item is byte-identical to pre-0098 otherwise.
   * Rendered for the GENERATOR advisory only, never the verifier /
   * citations (the G4 verifier-parity exception; more trap-exposed than
   * the advice string — see trajectory-digest.ts).
   */
  trajectory?: ToolStep[] | undefined;
  verifiedOutcome?: VerifiedOutcome | undefined;
  outcomeEvidenceRef?: string | undefined;
  /**
   * Whether the outcomeEvidenceRef was resolved/verified. It is an opaque
   * caller-asserted pointer with no tenant table to resolve against, so
   * capture persists it stamped `false` (0099): the ref is a CLAIM, never
   * proof. Absent on items that carry no ref.
   */
  outcomeEvidenceVerified?: boolean | undefined;
  /**
   * Revision provenance (0099): when this item is a candidate proposed to
   * replace an already-serving `active` row (the capture path never mutates
   * an active row in place), this points at the superseded active row's id.
   * Absent on ordinary candidates/actives.
   */
  supersedesId?: string | undefined;
}

export interface ScoredStrategyItem extends StrategyItem {
  similarity: number;
}

export interface CreateStrategyArgs {
  title: string;
  situation: string;
  strategy: string;
  polarity: StrategyPolarity;
  status?: StrategyStatus;
  evidence?: StrategyEvidence;
  scope?: StrategyScope;
  /**
   * Experience-memory fields (0098). Written ONLY when the trajectories
   * flag is on (a hard service-side gate — see create()); when off they
   * are silently dropped so no trajectory column is ever written.
   */
  trajectory?: ToolStep[] | undefined;
  verifiedOutcome?: VerifiedOutcome | undefined;
  outcomeEvidenceRef?: string | undefined;
  /**
   * Revision provenance (0099): set when this item is a candidate proposed
   * to supersede an already-serving `active` row — capture proposes a
   * revision rather than mutating the live row in place. The active row it
   * points at is left byte-identical until a human promotes the revision.
   */
  supersedesId?: string | undefined;
}

/** Retrieval k is hard-capped: k=1 default, 2 absolute max (G4). */
export const STRATEGY_RETRIEVAL_MAX_K = 2;

/** Auto-deprecation thresholds (G4 lifecycle). */
export const STRATEGY_MAX_CONTRADICT = 2;
export const STRATEGY_STALE_DAYS = 90;

/** Clamp a requested k into [1, STRATEGY_RETRIEVAL_MAX_K]; default 1. */
export function clampStrategyK(k?: number): number {
  if (k === undefined || !Number.isFinite(k) || k < 1) return 1;
  return Math.min(Math.floor(k), STRATEGY_RETRIEVAL_MAX_K);
}

/**
 * Pure lifecycle decision for the cron sweep: deprecate when the
 * contradiction counter reached the threshold, or the item went
 * STRATEGY_STALE_DAYS without validation (lastValidatedAt, falling
 * back to createdAt for never-validated items).
 */
export function shouldDeprecate(
  item: Pick<StrategyItem, 'evidence' | 'createdAt'>,
  now: Date,
): boolean {
  const contradictions =
    typeof item.evidence?.nContradict === 'number' ? item.evidence.nContradict : 0;
  if (contradictions >= STRATEGY_MAX_CONTRADICT) return true;
  const anchorRaw = item.evidence?.lastValidatedAt ?? item.createdAt;
  const anchor = Date.parse(String(anchorRaw));
  if (!Number.isFinite(anchor)) return false;
  const ageDays = (now.getTime() - anchor) / (24 * 60 * 60 * 1000);
  return ageDays > STRATEGY_STALE_DAYS;
}

/**
 * One advisory prompt line per served item (title + preconditions +
 * lesson). When the served item carries a tool trajectory (0098,
 * STRATEGY_TRAJECTORIES_ENABLED) a compact past-path suffix is appended
 * — GENERATOR-only guidance, never evidence. Without a trajectory the
 * output is byte-identical to pre-0098 (the suffix is ''), which is why
 * an item read with the flag off — where the columns are never selected
 * and `trajectory` stays undefined — renders exactly as it did before.
 */
export function renderStrategyNote(item: ScoredStrategyItem): string {
  const tag = item.polarity === 'avoid' ? 'AVOID' : 'DO';
  return (
    `[${tag}] ${item.title} — applies when: ${item.situation}. ${item.strategy}` +
    renderTrajectorySuffix(item)
  );
}

interface RawStrategyRow {
  id: unknown;
  companyId?: string;
  title?: string;
  situation?: string;
  strategy?: string;
  polarity?: string;
  status?: string;
  evidence?: Record<string, unknown>;
  embedding?: number[];
  scope?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  // 0099 revision pointer — selected always (revision is master-gated, not
  // trajectory-gated: the post-mortem distill path can propose one too).
  supersedesId?: unknown;
  // 0098 columns — selected ONLY when the trajectories flag is on
  // (TRAJECTORY_ROW_FIELDS), so on the off path they are always absent
  // and the mapper leaves the item byte-identical to pre-0098.
  trajectory?: unknown;
  verifiedOutcome?: unknown;
  outcomeEvidenceRef?: unknown;
  // 0099 caller-asserted-evidence label — trajectory-gated (written only
  // alongside outcomeEvidenceRef), so on the off path it is always absent.
  outcomeEvidenceVerified?: unknown;
}

const STRATEGY_ROW_FIELDS =
  'id, companyId, title, situation, strategy, polarity, status, ' +
  'evidence, scope, createdAt, updatedAt, supersedesId';

/** 0098/0099 additive columns, appended to the SELECT only when serving trajectories. */
const TRAJECTORY_ROW_FIELDS =
  'trajectory, verifiedOutcome, outcomeEvidenceRef, outcomeEvidenceVerified';

@Injectable()
export class StrategyMemoryService {
  private readonly logger = new Logger(StrategyMemoryService.name);
  // Feature master switch + read-side serving switch + similarity
  // floor: constructor-captured knobs (the PromotionRunnerService
  // template) — catalogued runtimeMutable:false.
  private readonly enabled: boolean;
  private readonly retrievalEnabled: boolean;
  private readonly trajectoriesEnabled: boolean;
  private readonly similarityFloor: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    config: ConfigService,
  ) {
    this.enabled = envFlagEnabled(config.get<string>('STRATEGY_MEMORY_ENABLED'));
    this.retrievalEnabled = envFlagEnabled(config.get<string>('STRATEGY_RETRIEVAL_ENABLED'));
    // Experience-memory extension (0098): mirrors how STRATEGY_MEMORY_
    // ENABLED is read — constructor-captured, runtimeMutable:false. Off
    // (default) ⇒ trajectory columns are never written or selected, so
    // serving is byte-identical to pre-0098.
    this.trajectoriesEnabled = envFlagEnabled(config.get<string>('STRATEGY_TRAJECTORIES_ENABLED'));
    // Unset/blank must NOT collapse to Number('')===0 (the
    // nonNegativeFloatEnv lesson): an absent knob means DEFAULT 0.4,
    // not "no floor".
    const rawFloor = (config.get<string>('STRATEGY_SIMILARITY_FLOOR') ?? '').trim();
    const floor = rawFloor === '' ? Number.NaN : Number(rawFloor);
    this.similarityFloor = Number.isFinite(floor) && floor >= 0 ? floor : 0.4;
  }

  /** Whole-feature master switch (lane + endpoints + cron). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Read-side serving switch — gates retrieve() on top of the master. */
  isRetrievalEnabled(): boolean {
    return this.enabled && this.retrievalEnabled;
  }

  /**
   * Experience-memory switch (0098): gates trajectory capture (write)
   * and trajectory column serving (read) on top of the master. Off ⇒ no
   * trajectory column is written or selected → byte-identical to pre-0098.
   */
  isTrajectoriesEnabled(): boolean {
    return this.enabled && this.trajectoriesEnabled;
  }

  /**
   * Build the SurrealQL fragment + params for the 0098 experience columns
   * shared by create() (CONTENT `key: $key`) and mergeUpdate() (SET
   * `key = $key`). Returns EMPTY fragments when the trajectories flag is
   * off — the load-bearing "no trajectory written when off" guarantee —
   * and includes only the fields actually supplied (so the option<string>
   * ASSERT is never handed a NULL).
   */
  private trajectoryWriteFragment(fields: {
    trajectory?: ToolStep[] | undefined;
    verifiedOutcome?: VerifiedOutcome | undefined;
    outcomeEvidenceRef?: string | undefined;
  }): { content: string; set: string; params: Record<string, unknown> } {
    if (!this.trajectoriesEnabled) return { content: '', set: '', params: {} };
    const cols: string[] = [];
    const params: Record<string, unknown> = {};
    if (fields.trajectory !== undefined) {
      cols.push('trajectory');
      params.trajectory = fields.trajectory;
    }
    if (fields.verifiedOutcome !== undefined) {
      cols.push('verifiedOutcome');
      params.verifiedOutcome = fields.verifiedOutcome;
    }
    if (fields.outcomeEvidenceRef !== undefined) {
      cols.push('outcomeEvidenceRef');
      params.outcomeEvidenceRef = fields.outcomeEvidenceRef;
      // 0099: the ref is an opaque CALLER-ASSERTED pointer with no tenant
      // table to resolve against — persist it explicitly stamped unverified
      // so nothing downstream can mistake the claim for proof. Co-written
      // with the ref (never without one), so it inherits the same gate.
      cols.push('outcomeEvidenceVerified');
      params.outcomeEvidenceVerified = false;
    }
    return {
      content: cols.map((c) => `,\n            ${c}: $${c}`).join(''),
      set: cols.map((c) => `${c} = $${c}`).join(', '),
      params,
    };
  }

  async create(companyId: string, args: CreateStrategyArgs): Promise<StrategyItem> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Embed the retrieval key: situation carries the preconditions
      // the query is matched against; title disambiguates near-twins.
      const embedding = await this.embedder.embed(`${args.title}\n${args.situation}`);
      // 0098 experience fields: a HARD service-side gate — only when the
      // trajectories flag is on AND a field was supplied does it enter the
      // CONTENT. Off ⇒ this fragment is empty and the CREATE is
      // byte-identical to pre-0098. (Each field is included individually
      // rather than passing null, so the option<string> ASSERT is never
      // handed a NULL it would reject.)
      const traj = this.trajectoryWriteFragment(args);
      // 0099 revision pointer: master-gated (NOT trajectory-gated), included
      // only when a supersedesId was supplied — a revision candidate points
      // at the active row it proposes to replace. Absent otherwise ⇒ the
      // CONTENT is byte-identical to a non-revision create.
      const revisionContent = args.supersedesId ? ',\n            supersedesId: $supersedesId' : '';
      const [row] = await db.query<RawStrategyRow[]>(
        `CREATE ONLY strategy_memory CONTENT {
            companyId: $companyId,
            title: $title,
            situation: $situation,
            strategy: $strategy,
            polarity: $polarity,
            status: $status,
            evidence: $evidence,
            embedding: $embedding,
            scope: $scope,
            createdAt: time::now(),
            updatedAt: time::now()${revisionContent}${traj.content}
         }`,
        {
          companyId,
          title: args.title,
          situation: args.situation,
          strategy: args.strategy,
          polarity: args.polarity,
          status: args.status ?? 'candidate',
          evidence: args.evidence ?? {},
          embedding,
          scope: args.scope ?? 'tenant',
          ...(args.supersedesId ? { supersedesId: args.supersedesId } : {}),
          ...traj.params,
        },
      );
      if (!row) throw new Error('strategy_memory CREATE returned nothing');
      this.logger.log(
        `[strategy.created] companyId=${companyId} id=${String(row.id)} status=${row.status}`,
      );
      return mapStrategyRow(row);
    });
  }

  async list(
    companyId: string,
    args: { status?: StrategyStatus | undefined; limit?: number | undefined } = {},
  ): Promise<StrategyItem[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const filter = args.status
        ? 'WHERE companyId = $companyId AND status = $status'
        : 'WHERE companyId = $companyId';
      const [rows] = await db.query<RawStrategyRow[][]>(
        `SELECT ${STRATEGY_ROW_FIELDS}
           FROM strategy_memory
           ${filter}
           ORDER BY updatedAt DESC
           LIMIT $limit`,
        {
          companyId,
          limit: args.limit ?? 50,
          ...(args.status ? { status: args.status } : {}),
        },
      );
      return ((rows as RawStrategyRow[]) ?? []).map(mapStrategyRow);
    });
  }

  /** Status flip (candidate→active confirmation, manual deprecation). */
  async updateStatus(
    companyId: string,
    strategyIdRaw: string,
    status: StrategyStatus,
  ): Promise<StrategyItem> {
    return this.surreal.withCompany(companyId, async (db) => {
      const tail = idTail(strategyIdRaw);
      const [rows] = await db.query<RawStrategyRow[][]>(
        `UPDATE type::record('strategy_memory', $tail)
           SET status = $status, updatedAt = time::now()
           WHERE companyId = $companyId
           RETURN AFTER`,
        { tail, status, companyId },
      );
      const updated = (rows as RawStrategyRow[])?.[0];
      if (!updated) {
        throw new NotFoundException(`Strategy ${strategyIdRaw} not found`);
      }
      const item = mapStrategyRow(updated);
      // 0099 promotion-deprecation: promoting a REVISION candidate (one that
      // carries a supersedesId) to active deprecates the old active row it
      // supersedes, so two actives never serve the same slot. Scoped by
      // companyId and guarded on `status = 'active'` — idempotent, and it
      // never demotes a row an operator has since re-activated for another
      // reason. Best-effort: a failure here does not fail the promotion.
      if (status === 'active' && item.supersedesId) {
        try {
          await db.query(
            `UPDATE type::record('strategy_memory', $supTail)
               SET status = 'deprecated', updatedAt = time::now()
               WHERE companyId = $companyId AND status = 'active'`,
            { supTail: idTail(item.supersedesId), companyId },
          );
          this.logger.log(
            `[strategy.superseded] companyId=${companyId} promoted=${String(updated.id)} ` +
              `deprecated=${item.supersedesId}`,
          );
        } catch (e) {
          this.logger.warn(
            `superseded-deprecate ${item.supersedesId} failed: ${(e as Error).message}`,
          );
        }
      }
      return item;
    });
  }

  /** Merge-update of an existing item (the dedup-merge UPDATE arm). */
  async mergeUpdate(
    companyId: string,
    strategyIdRaw: string,
    patch: {
      strategy?: string | undefined;
      situation?: string | undefined;
      evidence: StrategyEvidence;
      // 0098: the UPDATE arm of a trajectory capture attaches the latest
      // experience. Written only when the trajectories flag is on (the
      // shared write-fragment gate); dropped otherwise.
      trajectory?: ToolStep[] | undefined;
      verifiedOutcome?: VerifiedOutcome | undefined;
      outcomeEvidenceRef?: string | undefined;
    },
  ): Promise<StrategyItem> {
    return this.surreal.withCompany(companyId, async (db) => {
      const tail = idTail(strategyIdRaw);
      const traj = this.trajectoryWriteFragment(patch);
      const sets = [
        'evidence = $evidence',
        'updatedAt = time::now()',
        ...(patch.strategy ? ['strategy = $strategy'] : []),
        ...(patch.situation ? ['situation = $situation'] : []),
        ...(traj.set ? [traj.set] : []),
      ].join(', ');
      const [rows] = await db.query<RawStrategyRow[][]>(
        `UPDATE type::record('strategy_memory', $tail)
           SET ${sets}
           WHERE companyId = $companyId
           RETURN AFTER`,
        {
          tail,
          companyId,
          evidence: patch.evidence,
          ...(patch.strategy ? { strategy: patch.strategy } : {}),
          ...(patch.situation ? { situation: patch.situation } : {}),
          ...traj.params,
        },
      );
      const updated = (rows as RawStrategyRow[])?.[0];
      if (!updated) {
        throw new NotFoundException(`Strategy ${strategyIdRaw} not found`);
      }
      return mapStrategyRow(updated);
    });
  }

  /**
   * Serving retrieval: brute cosine over ACTIVE items only, floor
   * applied, k clamped to [1,2] (default 1). Empty when the read side
   * is off — the read flag is a hard gate here so no caller can serve
   * strategies past it.
   */
  async retrieve(companyId: string, query: string, k?: number): Promise<ScoredStrategyItem[]> {
    if (!this.isRetrievalEnabled()) return [];
    return this.scoredMatch(companyId, query, {
      statuses: ['active'],
      k: clampStrategyK(k),
      floor: this.similarityFloor,
    });
  }

  /**
   * Dedup-merge neighbor lookup (write path): top-k similar items
   * over candidate+active regardless of the serving flag — the
   * distiller must see near-twins even while serving is off. No
   * similarity floor: the merge LLM judges relatedness itself.
   */
  async findSimilar(companyId: string, text: string, k = 3): Promise<ScoredStrategyItem[]> {
    return this.scoredMatch(companyId, text, {
      statuses: ['candidate', 'active'],
      k,
      floor: 0,
    });
  }

  private async scoredMatch(
    companyId: string,
    text: string,
    opts: { statuses: StrategyStatus[]; k: number; floor: number },
  ): Promise<ScoredStrategyItem[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const q = await this.embedder.embed(text);
      // 0098: the trajectory columns are appended to the projection ONLY
      // when the flag is on. Off ⇒ the SELECT is character-identical to
      // pre-0098, the rows carry no trajectory, and every served/mapped
      // item is byte-identical (mapStrategyRow leaves the fields off).
      const projection = this.trajectoriesEnabled
        ? `${STRATEGY_ROW_FIELDS}, ${TRAJECTORY_ROW_FIELDS}, embedding`
        : `${STRATEGY_ROW_FIELDS}, embedding`;
      const [rows] = await db.query<RawStrategyRow[][]>(
        `SELECT ${projection}
           FROM strategy_memory
           WHERE companyId = $companyId
             AND status INSIDE $statuses
             AND embedding != NONE`,
        { companyId, statuses: opts.statuses },
      );
      const scored: ScoredStrategyItem[] = [];
      for (const r of (rows as RawStrategyRow[]) ?? []) {
        const emb = Array.isArray(r.embedding) ? r.embedding : null;
        if (!emb) continue;
        const sim = cosineSimilarity(q, emb);
        if (sim < opts.floor) continue;
        scored.push({ ...mapStrategyRow(r), similarity: sim });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, opts.k);
    });
  }

  /**
   * Lifecycle sweep (cron host): auto-deprecate items whose evidence
   * says they stopped working (nContradict ≥ 2) or that went 90d
   * without validation. Bounded by the tenant's own table size —
   * strategy memory is a curated distillate.
   */
  async deprecateSweep(
    companyId: string,
    now: Date = new Date(),
  ): Promise<{ companyId: string; scanned: number; deprecated: number }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<RawStrategyRow[][]>(
        `SELECT ${STRATEGY_ROW_FIELDS}
           FROM strategy_memory
           WHERE companyId = $companyId
             AND status INSIDE ['candidate', 'active']`,
        { companyId },
      );
      const items = ((rows as RawStrategyRow[]) ?? []).map(mapStrategyRow);
      let deprecated = 0;
      for (const item of items) {
        if (!shouldDeprecate(item, now)) continue;
        try {
          await db.query(
            `UPDATE type::record('strategy_memory', $tail)
               SET status = 'deprecated', updatedAt = time::now()`,
            { tail: idTail(item.strategyId) },
          );
          deprecated++;
        } catch (e) {
          this.logger.warn(`deprecate ${item.strategyId} failed: ${(e as Error).message}`);
        }
      }
      if (deprecated > 0) {
        this.logger.log(
          `[strategy.sweep] companyId=${companyId} deprecated=${deprecated}/${items.length}`,
        );
      }
      return { companyId, scanned: items.length, deprecated };
    });
  }
}

function idTail(raw: string): string {
  return raw.startsWith('strategy_memory:') ? raw.slice('strategy_memory:'.length) : raw;
}

function mapStrategyRow(r: RawStrategyRow): StrategyItem {
  const item: StrategyItem = {
    strategyId: String(r.id),
    companyId: String(r.companyId ?? ''),
    title: String(r.title ?? ''),
    situation: String(r.situation ?? ''),
    strategy: String(r.strategy ?? ''),
    polarity: (r.polarity === 'avoid' ? 'avoid' : 'do') as StrategyPolarity,
    status: (['candidate', 'active', 'deprecated'].includes(String(r.status))
      ? r.status
      : 'candidate') as StrategyStatus,
    evidence: (r.evidence ?? {}) as StrategyEvidence,
    scope: (r.scope === 'global' ? 'global' : 'tenant') as StrategyScope,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
  // 0098: attach experience fields ONLY when the row actually carries
  // them. On the flag-off path they are never selected, so they are
  // undefined here and the item is byte-identical to pre-0098. (An empty
  // stored trajectory also maps to "absent" so it never renders.)
  const trajectory = mapTrajectory(r.trajectory);
  if (trajectory) item.trajectory = trajectory;
  if (isVerifiedOutcome(r.verifiedOutcome)) item.verifiedOutcome = r.verifiedOutcome;
  if (typeof r.outcomeEvidenceRef === 'string' && r.outcomeEvidenceRef) {
    item.outcomeEvidenceRef = r.outcomeEvidenceRef;
  }
  // 0099: caller-asserted-evidence label — only present when a ref was
  // stored (co-written), so the field pins the ref as an unverified claim.
  if (typeof r.outcomeEvidenceVerified === 'boolean') {
    item.outcomeEvidenceVerified = r.outcomeEvidenceVerified;
  }
  // 0099: revision pointer — present only on a candidate that supersedes an
  // active row; absent (NONE → undefined) on ordinary items.
  if (typeof r.supersedesId === 'string' && r.supersedesId) {
    item.supersedesId = r.supersedesId;
  }
  return item;
}

/** Parse a stored trajectory column into typed ToolStep[]; undefined when absent/empty. */
function mapTrajectory(raw: unknown): ToolStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: ToolStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    steps.push({
      tool: typeof o.tool === 'string' ? o.tool : '',
      argsDigest: typeof o.argsDigest === 'string' ? o.argsDigest : '',
      resultDigest: typeof o.resultDigest === 'string' ? o.resultDigest : '',
      ok: o.ok === true,
    });
  }
  return steps.length > 0 ? steps : undefined;
}

function toIso(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return String(v);
}
