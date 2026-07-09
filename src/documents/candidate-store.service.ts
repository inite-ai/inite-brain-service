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
          `SELECT id FROM indexer_run
           WHERE docId = type::record('source_document', $doc)
             AND packId = $pack AND packVersion = $ver LIMIT 1`,
          { doc: idTailOf(p.docId), pack: p.packId, ver: p.packVersion },
        );
        const existing = ((rows as any[]) ?? [])[0];
        if (!existing) throw err;
        return { runId: String(existing.id), created: false };
      }
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
