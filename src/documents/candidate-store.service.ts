import { Injectable, Optional } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
} from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { idTailOf } from '../ingest/ingest-utils';
import type { CandidateBatch, CandidateKind } from '../indexers/candidate.types';
import { indexerIdOfPredicate } from '../indexers/virtual-attributor';

/** A candidate row as loaded for the Brain commit step. */
export interface CandidateRow {
  id: string;
  runId: string;
  chunkSeq: number;
  kind: CandidateKind;
  confidence: number;
  status: string;
  statusReason?: string;
  commitRef?: string;
  payload: Record<string, any>;
}

export interface RunHandle {
  runId: string;
  /** false = the (doc, pack, version) run already existed — skip. */
  created: boolean;
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
   * recoverable — a terminal 'failed' run, or one stuck 'running' past the
   * stale window (a crashed worker whose job lease has long expired). Left
   * un-reopened, a transient LLM error would make the (doc, pack, version)
   * slot permanently skip: retries and re-POSTs would hit the ledger and
   * return 'skipped', so the document's extraction is lost forever. A
   * freshly 'running' run is another worker actively extracting — never
   * reopen it (would double-stage candidates). 'succeeded' is a real skip.
   */
  async createRun(
    companyId: string,
    p: {
      docId: string;
      packId: string;
      packVersion: string;
      model?: string;
      registryVersionHash?: string;
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
        });
        return { runId: String(row.id), created: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const [rows] = await db.query<[any[]]>(
          `SELECT id, status, createdAt FROM indexer_run
           WHERE docId = type::record('source_document', $doc)
             AND packId = $pack AND packVersion = $ver LIMIT 1`,
          { doc: idTailOf(p.docId), pack: p.packId, ver: p.packVersion },
        );
        const existing = ((rows as any[]) ?? [])[0];
        if (!existing) throw err;
        const status = String(existing.status);
        const runId = String(existing.id);
        const createdMs = existing.createdAt
          ? new Date(String(existing.createdAt)).getTime()
          : 0;
        const isStaleRunning =
          status === 'running' && Date.now() - createdMs > staleRunMs();
        if (status === 'failed' || isStaleRunning) {
          // Reopen: drop the prior attempt's staged candidates (re-extraction
          // re-inserts) and reset the ledger row to 'running'. option<> fields
          // clear with NONE (never NULL — 0049 is SCHEMAFULL).
          await db.query(
            `DELETE candidate WHERE runId = type::record('indexer_run', $run);
             UPDATE type::record('indexer_run', $run) SET
               status = 'running', createdAt = time::now(),
               finishedAt = NONE, error = NONE, stats = NONE`,
            { run: idTailOf(runId) },
          );
          this.metrics?.countIndexerRun('reopened');
          return { runId, created: true };
        }
        return { runId, created: false };
      }
    });
  }

  /**
   * Reap indexer_run rows stuck 'running' past the stale window — a worker
   * that crashed between createRun and finalizeRun leaves the row open
   * forever, and countNonTerminalRuns then defers the document's commit
   * indefinitely (its pending candidates eventually expire = silent memory
   * loss). Mark them 'failed' so commit can settle over the runs that
   * succeeded. Returns the reaped run count.
   */
  async reapStaleRuns(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT count() AS c FROM indexer_run
           WHERE status = 'running'
             AND createdAt < time::now() - duration::from::millis($ms)
           GROUP ALL`,
        { ms: staleRunMs() },
      );
      const count = Number(((rows as any[]) ?? [])[0]?.c ?? 0);
      if (count > 0) {
        await db.query(
          `UPDATE indexer_run SET
             status = 'failed', finishedAt = time::now(),
             error = { message: 'stale_reaped' }
           WHERE status = 'running'
             AND createdAt < time::now() - duration::from::millis($ms)
           RETURN NONE`,
          { ms: staleRunMs() },
        );
        this.metrics?.countIndexerRun('stale_reaped');
      }
      return count;
    });
  }

  /**
   * Documents that still have staged (pending) candidates while sitting in
   * a pre-commit state — a commit that was lost (the last run's enqueue
   * failed, or its run was stuck 'running' and just got reaped). The
   * reconciler re-drives their commit; commitIfRunsSettled itself defers if
   * any run is still genuinely open, so enqueuing is always safe. Bounded so
   * one nightly pass can't run unbounded work.
   */
  async findDocsNeedingCommit(
    companyId: string,
    limit = 500,
  ): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Record-link traversal (docId.status) fetches the parent document's
      // status; dedup + cap happen in TS to avoid a GROUP-BY-VALUE idiom.
      const [rows] = await db.query<[any[]]>(
        `SELECT docId, docId.status AS docStatus FROM candidate
           WHERE status = 'pending' LIMIT 5000`,
      );
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of ((rows as any[]) ?? []) as any[]) {
        const docStatus = String(r.docStatus ?? '');
        if (docStatus !== 'indexing' && docStatus !== 'indexed') continue;
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
  ): Promise<{ entities: number; facts: number; relations: number }> {
    const { batch } = p;
    const prov = batch.provenance;
    return this.surreal.withCompany(companyId, async (db) => {
      for (const e of batch.entities) {
        await this.insertRow(db, {
          ...p,
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
        });
      }
      for (const f of batch.facts) {
        await this.insertRow(db, {
          ...p,
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
              prov.executionMode === 'virtual'
                ? indexerIdOfPredicate(f.predicate)
                : prov.indexerId,
            packVersion: prov.packVersion,
            executionMode: prov.executionMode,
            model: prov.model,
          },
        });
      }
      for (const r of batch.relations) {
        await this.insertRow(db, {
          ...p,
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
        });
      }
      this.metrics?.countCandidate('entity', 'created', batch.entities.length);
      this.metrics?.countCandidate('fact', 'created', batch.facts.length);
      this.metrics?.countCandidate('relation', 'created', batch.relations.length);
      return {
        entities: batch.entities.length,
        facts: batch.facts.length,
        relations: batch.relations.length,
      };
    });
  }

  /** Run ledger for a document — the async commit-readiness check. */
  async listRuns(
    companyId: string,
    docId: string,
  ): Promise<
    Array<{ runId: string; packId: string; packVersion: string; status: string }>
  > {
    return this.surreal.withCompany(companyId, async (db) => {
      // SurrealDB 3.x: the ORDER BY field must be in the projection
      // ("Missing order idiom" otherwise) — createdAt rides along.
      const [rows] = await db.query<[any[]]>(
        `SELECT id, packId, packVersion, status, createdAt FROM indexer_run
         WHERE docId = type::record('source_document', $doc)
         ORDER BY createdAt ASC`,
        { doc: idTailOf(docId) },
      );
      return (((rows as any[]) ?? []) as any[]).map((r) => ({
        runId: String(r.id),
        packId: String(r.packId),
        packVersion: String(r.packVersion),
        status: String(r.status),
      }));
    });
  }

  /** Runs still pending/running — commit defers while any exist. */
  async countNonTerminalRuns(companyId: string, docId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT count() AS c FROM indexer_run
         WHERE docId = type::record('source_document', $doc)
           AND status IN ['pending', 'running']
         GROUP ALL`,
        { doc: idTailOf(docId) },
      );
      const row = ((rows as any[]) ?? [])[0];
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
      statusReason?: string;
      commitRef?: string;
    }>,
  ): Promise<void> {
    if (!updates.length) return;
    await this.surreal.withCompany(companyId, async (db) => {
      for (const u of updates) {
        await db.query(
          `UPDATE type::record('candidate', $id) SET
             status = $status, statusReason = $reason, commitRef = $ref,
             decidedAt = time::now()`,
          {
            id: idTailOf(u.id),
            status: u.status,
            reason: u.statusReason,
            ref: u.commitRef,
          },
        );
      }
    });
  }

  private async insertRow(
    db: Surreal,
    p: {
      docId: string;
      runId: string;
      chunkSeq: number;
      kind: CandidateKind;
      confidence: number;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await dbCreate(db, 'candidate', {
      docId: recordRef('source_document', p.docId),
      runId: recordRef('indexer_run', p.runId),
      chunkSeq: p.chunkSeq,
      kind: p.kind,
      confidence: p.confidence,
      payload: p.payload,
      status: 'pending',
    });
  }

  private async loadByDoc(
    db: Surreal,
    p: { docId: string; onlyPending: boolean },
  ): Promise<CandidateRow[]> {
    const [rows] = await db.query<[any[]]>(
      `SELECT * FROM candidate
       WHERE docId = type::record('source_document', $doc)
         ${p.onlyPending ? `AND status = 'pending'` : ''}
       ORDER BY chunkSeq ASC, createdAt ASC`,
      { doc: idTailOf(p.docId) },
    );
    return (((rows as any[]) ?? []) as any[]).map((r) => ({
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
 * reopened underneath its worker. Default 30 minutes.
 */
function staleRunMs(): number {
  const mins = Number(process.env.INDEXER_RUN_STALE_MINUTES);
  return (Number.isFinite(mins) && mins > 0 ? mins : 30) * 60_000;
}
