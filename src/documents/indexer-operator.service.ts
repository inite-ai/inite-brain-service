import { Injectable, NotFoundException } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { IndexerRouterService } from '../indexers/indexer-router.service';
import type { IndexerBinding } from '../indexers/routing';
import type {
  IndexerCandidateTotals,
  IndexerExternalHealth,
  IndexerOverview,
  IndexerOverviewListResponse,
  IndexerRunListResponse,
  IndexerRunStats,
  IndexerRunSummary,
  IndexerRunTotals,
  IndexerWindow,
} from '../contracts/indexer/indexer-operator.schema';

/** Window defaults/caps — every aggregate on this surface is bounded. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
/** Runs read per indexer for the list view (the aggregate's row budget). */
const DEFAULT_LIST_RUN_CAP = 50;
const MAX_LIST_RUN_CAP = 200;
/** Runs returned by the per-pack detail route. */
const DEFAULT_DETAIL_LIMIT = 50;
const MAX_DETAIL_LIMIT = 200;
/** Upper bound on indexers enumerated in one response. */
const MAX_INDEXERS = 50;
/** Run ids per candidate-tally query — keeps the IN-list bounded. */
const CANDIDATE_ID_BATCH = 500;
/** An external publisher counts as "polling" if it claimed within this. */
const POLLED_WITHIN_HOURS = 24;
/** Ledger error messages are operator-facing text, not a payload dump. */
const ERROR_MAX_CHARS = 500;

const DAY_MS = 86_400_000;

/** Raw `indexer_run` projection this surface reads. */
interface OperatorRunRow {
  id: unknown;
  docId?: unknown;
  packId?: unknown;
  packVersion?: unknown;
  status?: unknown;
  external?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
  claimedAt?: unknown;
  stats?: unknown;
  error?: unknown;
}

/** GROUP BY runId, status tally over `candidate`. */
interface CandidateTallyRow {
  runId?: unknown;
  status?: unknown;
  n?: unknown;
}

/**
 * The OPERATOR view over a tenant's indexers — the read-only counterpart
 * to GET /v1/indexer/work (which is the external poller's OWN queue, not
 * an operator's view).
 *
 * An indexer's identity IS its pack: the `indexer` descriptor lives
 * inside the pack manifest, and `indexer_run` rows are keyed by
 * (docId, packId, packVersion). So "list the tenant's indexers" is
 * "list the tenant's packs that DECLARED an indexer descriptor" — the
 * router already resolves exactly that set (builtin + active installed),
 * and reusing it keeps ONE definition of "installed for this tenant".
 * A pack with no descriptor is absent: its facts ride the union pass and
 * it has no run ledger of its own.
 *
 * Fences:
 *  - every query runs inside `withCompany`, so a tenant's aggregate is
 *    computed from that tenant's rows only — there is no cross-tenant
 *    read path here, sanctioned or otherwise;
 *  - the pack set is the tenant's own bindings, so a foreign pack id on
 *    the detail route is a 404, not a probe of another tenant's ledger;
 *  - every read is window-bounded AND row-capped (`truncated` says when
 *    a cap bit), and hits `indexer_run_pack_idx` / `candidate_run_idx`.
 *
 * Read-only: nothing here writes, and no statement is a DELETE/UPDATE …
 * WHERE over an indexed field (the 3.2.4 planner hazard).
 */
@Injectable()
export class IndexerOperatorService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly router: IndexerRouterService,
  ) {}

  /** Every declared indexer of a tenant plus its run health. */
  async listIndexers(p: {
    companyId: string;
    days?: number | undefined;
    runCap?: number | undefined;
  }): Promise<IndexerOverviewListResponse> {
    const window = makeWindow(p.days, clamp(p.runCap, DEFAULT_LIST_RUN_CAP, MAX_LIST_RUN_CAP));
    const bindings = await this.declaredIndexers(p.companyId);
    const byPack = await this.runsByPack(
      p.companyId,
      bindings.map((b) => b.indexerId),
      window,
    );
    const tallies = await this.candidateTallies(
      p.companyId,
      [...byPack.values()].flatMap((rows) => rows.map((r) => r.id)),
    );
    const ctx = { tallies, runCap: window.runCap };
    const indexers = bindings.map((b) => overviewOf(b, byPack.get(b.indexerId) ?? [], ctx));
    return { tenant: p.companyId, window, indexers };
  }

  /** Recent runs of ONE declared indexer, newest first. */
  async listRuns(p: {
    companyId: string;
    packId: string;
    days?: number | undefined;
    limit?: number | undefined;
  }): Promise<IndexerRunListResponse> {
    const window = makeWindow(p.days, clamp(p.limit, DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT));
    const bindings = await this.declaredIndexers(p.companyId);
    if (!bindings.some((b) => b.indexerId === p.packId)) {
      throw new NotFoundException(`indexer "${p.packId}" is not installed for this tenant`);
    }
    const rows = (await this.runsByPack(p.companyId, [p.packId], window)).get(p.packId) ?? [];
    const tallies = await this.candidateTallies(
      p.companyId,
      rows.map((r) => r.id),
    );
    return {
      tenant: p.companyId,
      packId: p.packId,
      window,
      runs: rows.map((r) => runSummaryOf(r, tallies)),
      truncated: rows.length >= window.runCap,
    };
  }

  /**
   * The tenant's packs that DECLARED an `indexer` descriptor, capped and
   * ordered so the response is stable across calls.
   */
  private async declaredIndexers(companyId: string): Promise<IndexerBinding[]> {
    const bindings = await this.router.bindingsFor(companyId);
    return bindings
      .filter((b) => b.declared === true)
      .sort((a, b) => a.indexerId.localeCompare(b.indexerId))
      .slice(0, MAX_INDEXERS);
  }

  /**
   * Recent runs per pack. Deliberately ONE capped query per pack rather
   * than a single `packId INSIDE […]` scan: a shared cap lets one busy
   * indexer crowd every other one out of the window and silently skew
   * their aggregates.
   */
  private async runsByPack(
    companyId: string,
    packIds: string[],
    window: IndexerWindow,
  ): Promise<Map<string, OperatorRunRow[]>> {
    const out = new Map<string, OperatorRunRow[]>();
    if (packIds.length === 0) return out;
    await this.surreal.withCompany(companyId, async (db) => {
      for (const packId of packIds) {
        const rows = await queryRows<OperatorRunRow>(
          db,
          `SELECT id, docId, packId, packVersion, status, external,
                  createdAt, finishedAt, claimedAt, stats, error
             FROM indexer_run
             WHERE packId = $pack
               AND createdAt >= time::now() - duration::from_millis($windowMs)
             ORDER BY createdAt DESC
             LIMIT ${window.runCap}`,
          { pack: packId, windowMs: window.days * DAY_MS },
        );
        out.set(packId, rows);
      }
    });
    return out;
  }

  /** runId → candidate status tallies, over a bounded id set. */
  private async candidateTallies(
    companyId: string,
    runIds: unknown[],
  ): Promise<Map<string, IndexerCandidateTotals>> {
    const out = new Map<string, IndexerCandidateTotals>();
    if (runIds.length === 0) return out;
    await this.surreal.withCompany(companyId, async (db) => {
      for (let i = 0; i < runIds.length; i += CANDIDATE_ID_BATCH) {
        const batch = runIds.slice(i, i + CANDIDATE_ID_BATCH);
        const rows = await queryRows<CandidateTallyRow>(
          db,
          `SELECT runId, status, count() AS n FROM candidate
             WHERE runId INSIDE $ids
             GROUP BY runId, status`,
          { ids: batch },
        );
        for (const r of rows) {
          const key = String(r.runId ?? '');
          if (key === '') continue;
          const totals = out.get(key) ?? emptyCandidateTotals();
          addCandidateStatus(totals, String(r.status ?? ''), toCount(r.n));
          out.set(key, totals);
        }
      }
    });
    return out;
  }
}

/** Everything an overview row needs beyond its binding and its runs. */
interface OverviewContext {
  tallies: Map<string, IndexerCandidateTotals>;
  runCap: number;
}

function overviewOf(
  b: IndexerBinding,
  rows: OperatorRunRow[],
  ctx: OverviewContext,
): IndexerOverview {
  const { tallies } = ctx;
  const runs = emptyRunTotals();
  const candidates = emptyCandidateTotals();
  for (const r of rows) {
    addRunStatus(runs, String(r.status ?? ''));
    mergeCandidateTotals(candidates, tallies.get(String(r.id)) ?? emptyCandidateTotals());
  }
  const first = rows[0];
  return {
    packId: b.indexerId,
    packVersion: b.packVersion,
    mode: b.mode,
    source: b.source ?? 'builtin',
    description: b.description,
    installedAt: b.installedAt ? b.installedAt.toISOString() : null,
    lastRun: first ? runSummaryOf(first, tallies) : null,
    runs,
    candidates,
    external: b.mode === 'external' ? externalHealthOf(b, rows) : null,
    truncated: rows.length >= ctx.runCap,
  };
}

/**
 * External-publisher liveness from the ledger alone. There is no poll
 * journal, so the newest `claimedAt` in the window is the honest proxy
 * for "the publisher is alive"; a growing unclaimed backlog with a stale
 * (or absent) claim is what "the publisher stopped polling" looks like.
 */
function externalHealthOf(b: IndexerBinding, rows: OperatorRunRow[]): IndexerExternalHealth {
  let lastClaimMs: number | null = null;
  let pendingWork = 0;
  let oldestPendingMs: number | null = null;
  for (const r of rows) {
    if (r.external !== true) continue;
    const claimed = toMillis(r.claimedAt);
    if (claimed !== null && (lastClaimMs === null || claimed > lastClaimMs)) lastClaimMs = claimed;
    if (String(r.status ?? '') !== 'pending') continue;
    pendingWork += 1;
    const created = toMillis(r.createdAt);
    if (created !== null && (oldestPendingMs === null || created < oldestPendingMs)) {
      oldestPendingMs = created;
    }
  }
  const publisher = b.external?.publisher;
  return {
    publisher: publisher !== undefined && publisher !== '' ? publisher : null,
    pendingWork,
    oldestPendingAt: oldestPendingMs === null ? null : new Date(oldestPendingMs).toISOString(),
    lastClaimAt: lastClaimMs === null ? null : new Date(lastClaimMs).toISOString(),
    polledRecently:
      lastClaimMs !== null && Date.now() - lastClaimMs <= POLLED_WITHIN_HOURS * 3_600_000,
    polledWithinHours: POLLED_WITHIN_HOURS,
  };
}

function runSummaryOf(
  r: OperatorRunRow,
  tallies: Map<string, IndexerCandidateTotals>,
): IndexerRunSummary {
  const startedMs = toMillis(r.createdAt);
  const finishedMs = toMillis(r.finishedAt);
  return {
    runId: String(r.id),
    documentId: String(r.docId ?? ''),
    packVersion: String(r.packVersion ?? ''),
    status: String(r.status ?? ''),
    external: r.external === true,
    startedAt: startedMs === null ? '' : new Date(startedMs).toISOString(),
    finishedAt: finishedMs === null ? null : new Date(finishedMs).toISOString(),
    stats: statsOf(r.stats),
    error: errorOf(r.error),
    candidates: tallies.get(String(r.id)) ?? emptyCandidateTotals(),
  };
}

/** `stats` is a FLEXIBLE object — TS owns the shape, so read defensively. */
function statsOf(v: unknown): IndexerRunStats | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    chunks: toCount(o.chunks),
    entities: toCount(o.entities),
    facts: toCount(o.facts),
    relations: toCount(o.relations),
    durationMs: toCount(o.durationMs),
  };
}

function errorOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const msg = (v as Record<string, unknown>).message;
  if (msg === undefined || msg === null) return null;
  const text = String(msg).slice(0, ERROR_MAX_CHARS);
  return text === '' ? null : text;
}

function emptyRunTotals(): IndexerRunTotals {
  return { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
}

function addRunStatus(t: IndexerRunTotals, status: string): void {
  t.total += 1;
  if (status === 'pending') t.pending += 1;
  else if (status === 'running') t.running += 1;
  else if (status === 'succeeded') t.succeeded += 1;
  else if (status === 'failed') t.failed += 1;
  else if (status === 'skipped') t.skipped += 1;
}

function emptyCandidateTotals(): IndexerCandidateTotals {
  return {
    submitted: 0,
    pending: 0,
    committed: 0,
    merged: 0,
    duplicate: 0,
    rejected: 0,
    expired: 0,
  };
}

function addCandidateStatus(t: IndexerCandidateTotals, status: string, n: number): void {
  t.submitted += n;
  if (status === 'pending') t.pending += n;
  else if (status === 'committed') t.committed += n;
  else if (status === 'merged') t.merged += n;
  else if (status === 'duplicate') t.duplicate += n;
  else if (status === 'rejected') t.rejected += n;
  else if (status === 'expired') t.expired += n;
}

function mergeCandidateTotals(into: IndexerCandidateTotals, from: IndexerCandidateTotals): void {
  into.submitted += from.submitted;
  into.pending += from.pending;
  into.committed += from.committed;
  into.merged += from.merged;
  into.duplicate += from.duplicate;
  into.rejected += from.rejected;
  into.expired += from.expired;
}

/** The one place the window/cap bounds are decided. */
export function makeWindow(days: number | undefined, runCap: number): IndexerWindow {
  const d = clamp(days, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS);
  return { since: new Date(Date.now() - d * DAY_MS).toISOString(), days: d, runCap };
}

function clamp(v: number | undefined, fallback: number, max: number): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), max);
}

function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toMillis(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const ms = new Date(String(v)).getTime();
  return Number.isNaN(ms) ? null : ms;
}
