import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { envFlagEnabled } from '../common/env-validation';
import { cosineSimilarity } from '../common/vector-math';

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
    typeof item.evidence?.nContradict === 'number'
      ? item.evidence.nContradict
      : 0;
  if (contradictions >= STRATEGY_MAX_CONTRADICT) return true;
  const anchorRaw = item.evidence?.lastValidatedAt ?? item.createdAt;
  const anchor = Date.parse(String(anchorRaw));
  if (!Number.isFinite(anchor)) return false;
  const ageDays = (now.getTime() - anchor) / (24 * 60 * 60 * 1000);
  return ageDays > STRATEGY_STALE_DAYS;
}

/** One advisory prompt line per served item (title + preconditions + lesson). */
export function renderStrategyNote(item: ScoredStrategyItem): string {
  const tag = item.polarity === 'avoid' ? 'AVOID' : 'DO';
  return `[${tag}] ${item.title} — applies when: ${item.situation}. ${item.strategy}`;
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
}

const STRATEGY_ROW_FIELDS =
  'id, companyId, title, situation, strategy, polarity, status, ' +
  'evidence, scope, createdAt, updatedAt';

@Injectable()
export class StrategyMemoryService {
  private readonly logger = new Logger(StrategyMemoryService.name);
  // Feature master switch + read-side serving switch + similarity
  // floor: constructor-captured knobs (the PromotionRunnerService
  // template) — catalogued runtimeMutable:false.
  private readonly enabled: boolean;
  private readonly retrievalEnabled: boolean;
  private readonly similarityFloor: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    config: ConfigService,
  ) {
    this.enabled = envFlagEnabled(
      config.get<string>('STRATEGY_MEMORY_ENABLED'),
    );
    this.retrievalEnabled = envFlagEnabled(
      config.get<string>('STRATEGY_RETRIEVAL_ENABLED'),
    );
    // Unset/blank must NOT collapse to Number('')===0 (the
    // nonNegativeFloatEnv lesson): an absent knob means DEFAULT 0.4,
    // not "no floor".
    const rawFloor = (
      config.get<string>('STRATEGY_SIMILARITY_FLOOR') ?? ''
    ).trim();
    const floor = rawFloor === '' ? Number.NaN : Number(rawFloor);
    this.similarityFloor =
      Number.isFinite(floor) && floor >= 0 ? floor : 0.4;
  }

  /** Whole-feature master switch (lane + endpoints + cron). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Read-side serving switch — gates retrieve() on top of the master. */
  isRetrievalEnabled(): boolean {
    return this.enabled && this.retrievalEnabled;
  }

  async create(
    companyId: string,
    args: CreateStrategyArgs,
  ): Promise<StrategyItem> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Embed the retrieval key: situation carries the preconditions
      // the query is matched against; title disambiguates near-twins.
      const embedding = await this.embedder.embed(
        `${args.title}\n${args.situation}`,
      );
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
            updatedAt: time::now()
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
      return mapStrategyRow(updated);
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
    },
  ): Promise<StrategyItem> {
    return this.surreal.withCompany(companyId, async (db) => {
      const tail = idTail(strategyIdRaw);
      const sets = [
        'evidence = $evidence',
        'updatedAt = time::now()',
        ...(patch.strategy ? ['strategy = $strategy'] : []),
        ...(patch.situation ? ['situation = $situation'] : []),
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
  async retrieve(
    companyId: string,
    query: string,
    k?: number,
  ): Promise<ScoredStrategyItem[]> {
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
  async findSimilar(
    companyId: string,
    text: string,
    k = 3,
  ): Promise<ScoredStrategyItem[]> {
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
      const [rows] = await db.query<RawStrategyRow[][]>(
        `SELECT ${STRATEGY_ROW_FIELDS}, embedding
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
          this.logger.warn(
            `deprecate ${item.strategyId} failed: ${(e as Error).message}`,
          );
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
  return raw.startsWith('strategy_memory:')
    ? raw.slice('strategy_memory:'.length)
    : raw;
}

function mapStrategyRow(r: RawStrategyRow): StrategyItem {
  return {
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
