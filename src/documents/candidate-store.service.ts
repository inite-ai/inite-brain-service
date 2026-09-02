import { Injectable, Optional } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  queryFirst,
  queryRows,
} from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { idTailOf } from '../ingest/ingest-utils';
import type { CandidateBatch, CandidateKind } from '../indexers/candidate.types';
import { indexerIdOfPredicate } from '../indexers/virtual-attributor';

/**
 * insertBatch tallies, echoed into the submission response (`staged`) and
 * the run stats. scenes/stateDeltas appear ONLY when the batch carried
 * the 0110 arrays — flag-off payloads stay byte-identical.
 */
export interface InsertBatchCounts {
  entities: number;
  facts: number;
  relations: number;
  scenes?: number;
  stateDeltas?: number;
}

/** A candidate row as loaded for the Brain commit step. */
export interface CandidateRow {
  id: string;
  runId: string;
  chunkSeq: number;
  kind: CandidateKind;
  confidence: number;
  status: string;
  statusReason?: string | undefined;
  commitRef?: string | undefined;
  // A heterogeneous JSON blob whose shape differs by `kind`
  // (entity / fact / relation). Each consumer narrows the fields it
  // reads (candidate-merge.ts guards predicate/object as strings; the
  // redaction path spreads it as a record) — `unknown` values keep those
  // reads honest without an `any` escape hatch.
  payload: Record<string, unknown>;
}

/** count()…GROUP ALL projection — `c` is the group count. */
interface CountRow {
  c?: number;
}

/**
 * indexer_run row across the reopen/list/claim reads. Every field is a raw
 * DB value funneled through String()/Number()/new Date(), so `unknown` +
 * per-site coercion is the honest shape; individual SELECTs project a
 * subset of these columns.
 */
interface RunLedgerRow {
  id: unknown;
  docId?: unknown;
  packId?: unknown;
  packVersion?: unknown;
  status?: unknown;
  external?: unknown;
  claimToken?: unknown;
  createdAt?: unknown;
}

/** candidate → parent-document status probe (findDocsNeedingCommit). */
interface DocCommitRow {
  docId?: unknown;
  docStatus?: unknown;
}

/** A candidate row as `SELECT *` returns it, before coercion to CandidateRow. */
interface CandidateDbRow {
  id: unknown;
  runId?: unknown;
  chunkSeq?: unknown;
  kind: CandidateKind;
  confidence?: unknown;
  status?: unknown;
  statusReason?: unknown;
  commitRef?: unknown;
  payload?: Record<string, unknown>;
}

export interface RunHandle {
  runId: string;
  /** false = the (doc, pack, version) run already existed — skip. */
  created: boolean;
}

/** A run ledger row as the work-discovery/claim surface reads it. */
export interface RunRow {
  runId: string;
  docId: string;
  packId: string;
  packVersion: string;
  status: string;
  external: boolean;
  claimToken?: string | undefined;
  createdAt?: Date | undefined;
}

/**
 * Persistence for the Candidates layer (migration 0049): indexer_run
 * ledger rows + candidate rows. Pure storage — no merging, no decisions;
 * the Brain commit step owns those.
 */
@Injectable()
export class CandidateStoreService {
  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * INSERT-first idempotency: the UNIQUE (docId, packId, packVersion)
   * index makes "already processed" a unique violation, not a race.
   *
   * On that violation we inspect the existing run and REOPEN it when it is
   * recoverable: a 'pending' run this document's ingest pre-created (async
   * path — its job is now claiming it), a terminal 'failed' run, or one
   * stuck 'running' past the stale window (a crashed worker whose job
   * lease has long expired). Left un-reopened, a transient LLM error would
   * make the (doc, pack, version) slot permanently skip: retries and
   * re-POSTs would hit the ledger and return 'skipped', so the document's
   * extraction is lost forever. A freshly 'running' run is another worker
   * actively extracting — never reopen it (would double-stage candidates).
   * 'succeeded' is a real skip.
   *
   * The reopen is a COMPARE-AND-SWAP on the observed status: two jobs that
   * both see the same reopenable row (e.g. an async index job and a
   * reindex job that don't collide on the job-claim dedupKey) must not both
   * re-extract. Only the CAS winner gets `created:true`; the loser skips.
   */
  async createRun(
    companyId: string,
    p: {
      docId: string;
      packId: string;
      packVersion: string;
      model?: string | undefined;
      registryVersionHash?: string | undefined;
      /** Run belongs to an external (out-of-process) indexer — 0062. */
      external?: boolean;
    },
  ): Promise<RunHandle> {
    return this.surreal.withCompany(companyId, async (db) => {
      try {
        const row = await dbCreate<Record<string, unknown>>(db, 'indexer_run', {
          docId: recordRef('source_document', p.docId),
          packId: p.packId,
          packVersion: p.packVersion,
          model: p.model,
          registryVersionHash: p.registryVersionHash,
          status: 'running',
          external: p.external ?? false,
        });
        return { runId: String(row.id), created: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await queryFirst<RunLedgerRow>(
          db,
          `SELECT id, status, createdAt FROM indexer_run
           WHERE docId = type::record('source_document', $doc)
             AND packId = $pack AND packVersion = $ver LIMIT 1`,
          { doc: idTailOf(p.docId), pack: p.packId, ver: p.packVersion },
        );
        if (!existing) throw err;
        const status = String(existing.status);
        const runId = String(existing.id);
        const createdMs = existing.createdAt ? new Date(String(existing.createdAt)).getTime() : 0;
        const isStaleRunning = status === 'running' && Date.now() - createdMs > staleRunMs();
        if (status === 'pending' || status === 'failed' || isStaleRunning) {
          // Reopen under a CAS: only proceed if the row is STILL in the
          // status we observed (`RETURN AFTER` gives us the updated rows;
          // an empty result = a concurrent reopener already flipped it, so
          // we defer to it). Drop any prior attempt's staged candidates
          // (re-extraction re-inserts; a 'pending' run has none). option<>
          // fields clear with NONE (never NULL — 0049 is SCHEMAFULL).
          // Two statements → two result slots; the CAS verdict is the
          // UPDATE's (slot 1), not the DELETE's (slot 0).
          // Two statements → two result slots. The DELETE's rows (slot 0)
          // are unread; the CAS verdict is the UPDATE's RETURN AFTER (slot 1).
          const res = await db.query<[unknown[], unknown[]]>(
            `DELETE candidate WHERE runId = type::record('indexer_run', $run);
             UPDATE type::record('indexer_run', $run) SET
               status = 'running', createdAt = time::now(),
               finishedAt = NONE, error = NONE, stats = NONE
             WHERE status = $observed
             RETURN AFTER`,
            { run: idTailOf(runId), observed: status },
          );
          const swapped = res[1] ?? [];
          if (swapped.length === 0) {
            // Lost the race — another job reopened it and is extracting.
            return { runId, created: false };
          }
          this.metrics?.countIndexerRun('reopened');
          return { runId, created: true };
        }
        return { runId, created: false };
      }
    });
  }

  /**
   * Pre-create the ledger row for an async indexer run as 'pending', so
   * `countNonTerminalRuns` sees every planned run from the instant the
   * document is enqueued — NOT only once each job has started and called
   * createRun. Without this, the general pass could finish and commit
   * before a dedicated run's row exists (open-count 0), committing a
   * partial candidate set and losing the cross-indexer merge. Idempotent:
   * a row already present (any state) is left untouched — the job's
   * createRun handles the 'pending' → 'running' transition, and a re-POST
   * must not resurrect a terminal run.
   */
  async ensureRunPending(
    companyId: string,
    p: {
      docId: string;
      packId: string;
      packVersion: string;
      /** Pre-create as an external work item (pull API) — 0062. */
      external?: boolean;
    },
  ): Promise<void> {
    return this.surreal.withCompany(companyId, async (db) => {
      try {
        await dbCreate<Record<string, unknown>>(db, 'indexer_run', {
          docId: recordRef('source_document', p.docId),
          packId: p.packId,
          packVersion: p.packVersion,
          status: 'pending',
          external: p.external ?? false,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Row already exists — leave whatever state it's in.
      }
    });
  }

  /**
   * Reap non-terminal indexer_run rows past the stale window:
   *   - 'running' — a worker that crashed between createRun and finalizeRun
   *     leaves the row open forever (its job lease expired at ttlSeconds,
   *     well below the stale window, so this is the only recovery for a
   *     hard crash — SIGKILL/OOM never fires the graceful abort path);
   *   - 'pending' — an async run pre-created by ingest whose job was never
   *     claimed (worker fleet down at enqueue time).
   * Either state left un-reaped makes countNonTerminalRuns defer the
   * document's commit indefinitely, and its pending candidates eventually
   * expire = silent memory loss. Mark them 'failed' so commit settles over
   * the runs that succeeded. Returns the reaped run count.
   *
   * Latency note: between a hard crash and this reap the run sits orphaned
   * for up to the stale window (kept above the job lease so a legitimately
   * slow extraction is never falsely reopened). Candidates persist across
   * that gap — no data loss, only commit latency bounded by the reap
   * cadence and CANDIDATE_PENDING_TTL_DAYS.
   */
  async reapStaleRuns(companyId: string): Promise<number> {
    // External rows have their own lifecycle (0062):
    //   * 'pending' external rows are WORK ITEMS for a remote poller —
    //     a daily polling cadence is legitimate, so they expire on the
    //     (much longer) INDEXER_EXTERNAL_PENDING_TTL_DAYS, not the stale
    //     window;
    //   * 'running' external rows past the stale window are ABANDONED
    //     CLAIMS (lease rides createdAt, refreshed by heartbeat) — they
    //     go BACK to 'pending' so the work is rediscoverable by the next
    //     poll; marking them failed would silently drop the work item
    //     from discovery forever.
    const failWhere = `(external != true AND status IN ['running', 'pending']
             AND createdAt < time::now() - duration::from_millis($ms))
          OR (external = true AND status = 'pending'
             AND createdAt < time::now() - duration::from_millis($extMs))`;
    const releaseWhere = `external = true AND status = 'running'
             AND createdAt < time::now() - duration::from_millis($ms)`;
    return this.surreal.withCompany(companyId, async (db) => {
      const [failRows, releaseRows] = await db.query<[CountRow[], CountRow[]]>(
        `SELECT count() AS c FROM indexer_run WHERE ${failWhere} GROUP ALL;
         SELECT count() AS c FROM indexer_run WHERE ${releaseWhere} GROUP ALL`,
        { ms: staleRunMs(), extMs: externalPendingTtlMs() },
      );
      const failed = Number(failRows?.[0]?.c ?? 0);
      const released = Number(releaseRows?.[0]?.c ?? 0);
      if (failed > 0) {
        await db.query(
          `UPDATE indexer_run SET
             status = 'failed', finishedAt = time::now(),
             error = { message: 'stale_reaped' }
           WHERE ${failWhere}
           RETURN NONE`,
          { ms: staleRunMs(), extMs: externalPendingTtlMs() },
        );
        this.metrics?.countIndexerRun('stale_reaped');
      }
      if (released > 0) {
        // createdAt resets so the expiry clock restarts from the release —
        // an item can cycle claim→abandon→release, but each cycle costs a
        // full stale window, and the pending TTL bounds the total.
        await db.query(
          `UPDATE indexer_run SET
             status = 'pending', claimToken = NONE, claimedAt = NONE,
             createdAt = time::now()
           WHERE ${releaseWhere}
           RETURN NONE`,
          { ms: staleRunMs() },
        );
        this.metrics?.countIndexerRun('claim_released');
      }
      return failed + released;
    });
  }

  /**
   * Documents that still have staged (pending) candidates and a lost
   * commit. Two sources: (1) a run-driven commit that never landed (the
   * last run's enqueue failed, or its run was stuck 'running' and just got
   * reaped); (2) an EXTERNAL submission (`POST …/candidates`, no job/retry)
   * whose inline commit deferred/threw/died — these commonly target a doc
   * already in status 'committed'. So reconcile any doc with pending
   * candidates EXCEPT 'purged' (content erased — nothing to re-ground or
   * commit). commitIfRunsSettled itself defers if any run is still open, so
   * enqueuing is always safe. Bounded so one nightly pass can't run
   * unbounded work.
   */
  async findDocsNeedingCommit(companyId: string, limit = 500): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Record-link traversal (docId.status) fetches the parent document's
      // status; dedup + cap happen in TS to avoid a GROUP-BY-VALUE idiom.
      const rows = await queryRows<DocCommitRow>(
        db,
        `SELECT docId, docId.status AS docStatus FROM candidate
           WHERE status = 'pending' LIMIT 5000`,
      );
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of rows) {
        const docStatus = String(r.docStatus ?? '');
        // 'purged' facts have no source text left to commit against;
        // everything else with pending candidates is a lost commit —
        // including 'committed' docs an external submission re-staged.
        if (docStatus === 'purged' || docStatus === '') continue;
        const docId = String(r.docId);
        if (seen.has(docId)) continue;
        seen.add(docId);
        out.push(docId);
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  async finalizeRun(
    companyId: string,
    p: {
      runId: string;
      status: 'succeeded' | 'failed' | 'skipped';
      stats?: Record<string, unknown>;
      error?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(
        `UPDATE type::record('indexer_run', $id) SET
           status = $status, stats = $stats, error = $error,
           finishedAt = time::now()`,
        {
          id: idTailOf(p.runId),
          status: p.status,
          stats: p.stats,
          error: p.error,
        },
      );
    });
  }

  /**
   * Stage one chunk's CandidateBatch. Fact rows attribute their indexer by
   * predicate namespace (virtual composition); entity/relation rows carry
   * the physical run's indexer id — attribution for them is per-fact at
   * commit time.
   */
  async insertBatch(
    companyId: string,
    p: { docId: string; runId: string; chunkSeq: number; batch: CandidateBatch },
  ): Promise<InsertBatchCounts> {
    const { batch } = p;
    const prov = batch.provenance;
    return this.surreal.withCompany(companyId, async (db) => {
      // One INSERT for the whole chunk instead of one CREATE per
      // candidate (same pattern-port as changefeed-drain's audit_event
      // batch). A large document staged E+F+R serial round-trips per
      // chunk — thousands per indexer run; this is one RTT per chunk,
      // and single-statement staging makes the chunk atomic (a crash
      // can no longer leave a partially staged chunk behind).
      const shared = () => ({
        docId: recordRef('source_document', p.docId),
        runId: recordRef('indexer_run', p.runId),
        chunkSeq: p.chunkSeq,
        status: 'pending',
      });
      const rows: Record<string, unknown>[] = [
        ...batch.entities.map((e) => ({
          ...shared(),
          kind: 'entity',
          confidence: 0.5,
          payload: {
            entityIndex: e.entityIndex,
            name: e.name,
            type: e.type,
            canonical: e.canonical,
            ungrounded: e.ungrounded,
            indexerId: prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        })),
        ...batch.facts.map((f) => ({
          ...shared(),
          kind: 'fact',
          confidence: f.confidence,
          payload: {
            entityIndex: f.entityIndex,
            predicate: f.predicate,
            object: f.object,
            clause: f.clause,
            ungrounded: f.ungrounded,
            extractionEntropy: f.extractionEntropy,
            extractionAgreement: f.extractionAgreement,
            indexerId:
              prov.executionMode === 'virtual' ? indexerIdOfPredicate(f.predicate) : prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        })),
        ...batch.relations.map((r) => ({
          ...shared(),
          kind: 'relation',
          confidence: r.confidence,
          payload: {
            fromEntityIndex: r.fromEntityIndex,
            toEntityIndex: r.toEntityIndex,
            kind: r.kind,
            clause: r.clause,
            indexerId: prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        })),
        // 0110 episodic kinds (PACK_MEMORY_PROJECTIONS_ENABLED): absent on
        // every batch unless the external validator admitted them, so the
        // flag-off write path stages exactly the pre-0110 row set.
        ...(batch.scenes ?? []).map((s) => ({
          ...shared(),
          kind: 'scene',
          confidence: s.confidence,
          payload: {
            sceneIndex: s.sceneIndex,
            schemaId: s.schemaId,
            label: s.label,
            gist: s.gist,
            occurredFrom: s.occurredFrom,
            occurredTo: s.occurredTo,
            ungrounded: s.ungrounded,
            indexerId: prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        })),
        ...(batch.stateDeltas ?? []).map((d) => ({
          ...shared(),
          kind: 'state_delta',
          confidence: d.confidence,
          payload: {
            sceneIndex: d.sceneIndex,
            stateModelId: d.stateModelId,
            subject: d.subject,
            from: d.from,
            to: d.to,
            ungrounded: d.ungrounded,
            indexerId: prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        })),
      ];
      if (rows.length > 0) {
        await db.query(`INSERT INTO candidate $rows`, { rows });
      }
      this.metrics?.countCandidate('entity', 'created', batch.entities.length);
      this.metrics?.countCandidate('fact', 'created', batch.facts.length);
      this.metrics?.countCandidate('relation', 'created', batch.relations.length);
      this.metrics?.countCandidate('scene', 'created', batch.scenes?.length ?? 0);
      this.metrics?.countCandidate('state_delta', 'created', batch.stateDeltas?.length ?? 0);
      return {
        entities: batch.entities.length,
        facts: batch.facts.length,
        relations: batch.relations.length,
        // Present only when the batch carried the 0110 arrays — the
        // flag-off staged/stats payloads stay byte-identical.
        ...(batch.scenes ? { scenes: batch.scenes.length } : {}),
        ...(batch.stateDeltas ? { stateDeltas: batch.stateDeltas.length } : {}),
      };
    });
  }

  /** Run ledger for a document — the async commit-readiness check. */
  async listRuns(
    companyId: string,
    docId: string,
  ): Promise<Array<{ runId: string; packId: string; packVersion: string; status: string }>> {
    return this.surreal.withCompany(companyId, async (db) => {
      // SurrealDB 3.x: the ORDER BY field must be in the projection
      // ("Missing order idiom" otherwise) — createdAt rides along.
      const rows = await queryRows<RunLedgerRow>(
        db,
        `SELECT id, packId, packVersion, status, createdAt FROM indexer_run
         WHERE docId = type::record('source_document', $doc)
         ORDER BY createdAt ASC`,
        { doc: idTailOf(docId) },
      );
      return rows.map((r) => ({
        runId: String(r.id),
        packId: String(r.packId),
        packVersion: String(r.packVersion),
        status: String(r.status),
      }));
    });
  }

  /** One run row by id — the claim-token verification read. */
  async getRun(companyId: string, runId: string): Promise<RunRow | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Point-read by record id (no table scan under SSI — the #169 idiom).
      const r = await queryFirst<RunLedgerRow>(
        db,
        `SELECT id, docId, packId, packVersion, status, external,
                claimToken, createdAt
           FROM type::record('indexer_run', $run)`,
        { run: idTailOf(runId) },
      );
      if (!r) return null;
      return {
        runId: String(r.id),
        docId: String(r.docId),
        packId: String(r.packId),
        packVersion: String(r.packVersion),
        status: String(r.status),
        external: r.external === true,
        claimToken: r.claimToken ? String(r.claimToken) : undefined,
        createdAt: r.createdAt ? new Date(String(r.createdAt)) : undefined,
      };
    });
  }

  /**
   * Drop a run's staged candidates — the drop-and-restage step of a
   * claimed external submission (mirrors what createRun's reopen does).
   */
  async dropRunCandidates(companyId: string, runId: string): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(`DELETE candidate WHERE runId = type::record('indexer_run', $run)`, {
        run: idTailOf(runId),
      });
    });
  }

  /**
   * Runs still pending/running — commit defers while any exist. External
   * runs are excluded on both statuses (`external != true` also matches
   * pre-0062 rows where the field is NONE): a third-party indexer's
   * polling cadence must never hold the document's commit hostage. A late
   * external submission re-commits incrementally — the same reconcile
   * path that already handles external re-staging on committed docs.
   */
  async countNonTerminalRuns(companyId: string, docId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<CountRow>(
        db,
        `SELECT count() AS c FROM indexer_run
         WHERE docId = type::record('source_document', $doc)
           AND status IN ['pending', 'running']
           AND external != true
         GROUP ALL`,
        { doc: idTailOf(docId) },
      );
      return row ? Number(row.c) : 0;
    });
  }

  async loadPending(companyId: string, docId: string): Promise<CandidateRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      this.loadByDoc(db, { docId, onlyPending: true }),
    );
  }

  async listByDoc(companyId: string, docId: string): Promise<CandidateRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      this.loadByDoc(db, { docId, onlyPending: false }),
    );
  }

  /** Batch status transition after the Brain has decided. */
  async markStatuses(
    companyId: string,
    updates: Array<{
      id: string;
      status: string;
      statusReason?: string | undefined;
      commitRef?: string | undefined;
    }>,
  ): Promise<void> {
    if (!updates.length) return;
    await this.surreal.withCompany(companyId, async (db) => {
      // One FOR-loop statement instead of one UPDATE round-trip per
      // candidate. These writes run while holding the per-doc commit
      // lock, so the old per-row form stretched the window in which
      // re-commits defer — by thousands of RTTs on a large document.
      // (Side-effect-only FOR body — the "no cross-iteration variable
      // accumulation" SurrealQL limitation doesn't apply.)
      await db.query(
        `FOR $u IN $updates {
           UPDATE type::record($u.id) SET
             status = $u.status,
             statusReason = $u.reason ?? NONE,
             commitRef = $u.ref ?? NONE,
             decidedAt = time::now();
         };`,
        {
          updates: updates.map((u) => ({
            id: `candidate:${idTailOf(u.id)}`,
            status: u.status,
            reason: u.statusReason ?? null,
            ref: u.commitRef ?? null,
          })),
        },
      );
    });
  }

  private async loadByDoc(
    db: Surreal,
    p: { docId: string; onlyPending: boolean },
  ): Promise<CandidateRow[]> {
    const rows = await queryRows<CandidateDbRow>(
      db,
      `SELECT * FROM candidate
       WHERE docId = type::record('source_document', $doc)
         ${p.onlyPending ? `AND status = 'pending'` : ''}
       ORDER BY chunkSeq ASC, createdAt ASC`,
      { doc: idTailOf(p.docId) },
    );
    return rows.map((r) => ({
      id: String(r.id),
      runId: String(r.runId),
      chunkSeq: Number(r.chunkSeq),
      kind: r.kind,
      confidence: Number(r.confidence),
      status: String(r.status),
      statusReason: r.statusReason ? String(r.statusReason) : undefined,
      commitRef: r.commitRef ? String(r.commitRef) : undefined,
      payload: r.payload ?? {},
    }));
  }
}

/**
 * Bound-var-safe record link: dbCreate serializes bound objects verbatim,
 * and a record<> field needs a RecordId, not a plain string.
 */
function recordRef(table: string, rid: string): unknown {
  return new StringRecordId(`${table}:${idTailOf(rid)}`);
}

/**
 * How long a run may sit 'running' before it counts as stale (crashed).
 * Must comfortably exceed the index_document job lease (600s) plus the
 * longest realistic extraction, so a live long run is never reaped or
 * reopened underneath its worker. Default 30 minutes. Doubles as the
 * external claim lease (claim sets createdAt=now, heartbeat refreshes).
 */
export function staleRunMs(): number {
  const mins = Number(process.env.INDEXER_RUN_STALE_MINUTES);
  return (Number.isFinite(mins) && mins > 0 ? mins : 30) * 60_000;
}

/**
 * How long an UNCLAIMED external work item ('pending', external=true)
 * stays pollable before the sweep expires it — a remote indexer that
 * never showed up. Days-scale by design: a daily poller is a legitimate
 * integration.
 */
export function externalPendingTtlMs(): number {
  const days = Number(process.env.INDEXER_EXTERNAL_PENDING_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
}
