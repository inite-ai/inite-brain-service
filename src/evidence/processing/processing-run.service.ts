import { Inject, Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryFirst, queryRows } from '../../db/surreal.service';
import { evidenceDerivedMaxBytes } from '../../common/evidence-flags';
import type { DerivedRepresentationKind } from '../../common/evidence-taxonomy';
import { idTailOf, redactPiiWithReport } from '../../ingest/ingest-utils';
import { EvidenceStoreService } from '../evidence-store.service';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageRegistry,
} from '../storage/storage-adapter';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from './processor-adapter';
import { processingRunIdTail, processorConfigFingerprint } from './processor-fingerprint';

const ERROR_MAX = 500;

export interface ExecuteRunOpts {
  /** The loaded evidence_asset row's record id (RecordId, not string). */
  assetRecordId: unknown;
  packId: string;
  adapter: ProcessorAdapter;
  input: ProcessorInput;
}

export interface ExecuteRunResult {
  runId: string;
  capability: DerivedRepresentationKind;
  status: 'succeeded' | 'failed' | 'replayed' | 'skipped_in_flight';
  representationIds: string[];
}

/**
 * ProcessingRunService (0121 MM-5) — owns the processing_run row
 * lifecycle: idempotent claim (deterministic id + INSERT IGNORE, the #92
 * changefeed idiom), adapter execution, representation lineage
 * (producedByRun), and the supersede pass. The BROKER decides WHAT may
 * run (flags + dispatch gate); this service guarantees each (asset,
 * capability, processorVersion, configFingerprint) key executes at most
 * once — a replayed dispatch returns the recorded outputs without
 * touching the adapter.
 *
 * DB work is deliberately phased in separate withCompany scopes (claim →
 * adapter → write/complete) so the adapter never runs while holding a
 * pooled connection, and representation writes go through the ONE write
 * seam (EvidenceStoreService.addRepresentation) rather than a parallel
 * dbCreate path.
 */
@Injectable()
export class ProcessingRunService {
  private readonly logger = new Logger(ProcessingRunService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly store: EvidenceStoreService,
    /** Exposed for the broker's openStream construction (max-params 3:
     *  the broker reaches the storage registry through this service). */
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    readonly storageAdapters: EvidenceStorageRegistry,
  ) {}

  async execute(companyId: string, opts: ExecuteRunOpts): Promise<ExecuteRunResult> {
    const { adapter } = opts;
    const fingerprint = processorConfigFingerprint(adapter);
    const tail = processingRunIdTail({
      assetTail: idTailOf(String(opts.assetRecordId)),
      capability: adapter.capability,
      processorVersion: adapter.version,
      configFingerprint: fingerprint,
    });
    const runId = `processing_run:${tail}`;
    const claimed = await this.claimRun(companyId, {
      runId,
      tail,
      opts,
      fingerprint,
    });
    if (claimed) return claimed;

    let outputs: ProcessorOutput[];
    try {
      outputs = await adapter.process(opts.input);
      this.assertOutputsWithinCap(outputs);
    } catch (e) {
      await this.failRun(companyId, runId, e);
      return { runId, capability: adapter.capability, status: 'failed', representationIds: [] };
    }
    try {
      const representationIds = await this.writeOutputs(companyId, { runId, opts, outputs });
      await this.completeRun(companyId, { runId, opts, representationIds });
      return { runId, capability: adapter.capability, status: 'succeeded', representationIds };
    } catch (e) {
      await this.failRun(companyId, runId, e);
      return { runId, capability: adapter.capability, status: 'failed', representationIds: [] };
    }
  }

  /**
   * Claim the deterministic run row. INSERT IGNORE collides on the
   * primary key for a replay; the recovery SELECT (episode-store
   * duplicate pattern) decides what the collision means:
   *   succeeded  → replay: return recorded outputs, NO adapter call;
   *   superseded → replay-skip: a newer version owns the subject;
   *   running / pending → skipped_in_flight (v1 has no scheduler — this
   *     only guards concurrent test/manual calls);
   *   failed     → retry: flip back to running, attempts += 1, proceed.
   * Returns null when the caller should execute the adapter.
   */
  private async claimRun(
    companyId: string,
    claim: { runId: string; tail: string; opts: ExecuteRunOpts; fingerprint: string },
  ): Promise<ExecuteRunResult | null> {
    const { runId, tail, opts, fingerprint } = claim;
    const capability = opts.adapter.capability;
    return this.surreal.withCompany(companyId, async (db) => {
      const inserted = await queryRows<{ id: unknown }>(
        db,
        `INSERT IGNORE INTO processing_run $row`,
        {
          row: {
            id: new StringRecordId(runId),
            assetId: opts.assetRecordId,
            capability,
            processorVersion: opts.adapter.version,
            configFingerprint: fingerprint,
            packId: opts.packId,
            status: 'running',
            attempts: 1,
          },
        },
      );
      if (inserted.length > 0) return null; // fresh claim — execute
      const existing = await queryFirst<{ status: string; outputs?: unknown[] }>(
        db,
        `SELECT status, outputs FROM type::record('processing_run', $tail) LIMIT 1`,
        { tail },
      );
      if (!existing) {
        // INSERT IGNORE returned nothing AND no row exists — should be
        // unreachable; refuse rather than double-process.
        throw new Error(`processing run ${runId} collided but cannot be recovered`);
      }
      if (existing.status === 'succeeded' || existing.status === 'superseded') {
        return {
          runId,
          capability,
          status: 'replayed' as const,
          representationIds: (existing.outputs ?? []).map(String),
        };
      }
      if (existing.status === 'running' || existing.status === 'pending') {
        return { runId, capability, status: 'skipped_in_flight' as const, representationIds: [] };
      }
      // failed → retry under the same key.
      await db.query(`UPDATE $id SET status = 'running', attempts += 1`, {
        id: new StringRecordId(runId),
      });
      return null;
    });
  }

  /** Reject (never truncate) any over-cap output — silent truncation
   *  would alter derived content. */
  private assertOutputsWithinCap(outputs: ProcessorOutput[]): void {
    const cap = evidenceDerivedMaxBytes();
    for (const output of outputs) {
      if (output.content !== undefined && Buffer.byteLength(output.content, 'utf8') > cap) {
        throw new Error('derived output exceeds EVIDENCE_DERIVED_MAX_BYTES');
      }
    }
  }

  /** Write outputs through the ONE write seam, with lineage. */
  private async writeOutputs(
    companyId: string,
    write: { runId: string; opts: ExecuteRunOpts; outputs: ProcessorOutput[] },
  ): Promise<string[]> {
    const representationIds: string[] = [];
    for (const output of write.outputs) {
      const { representationId } = await this.store.addRepresentation(companyId, {
        subjectId: String(write.opts.assetRecordId),
        subjectKind: 'asset',
        kind: output.kind,
        content: output.content,
        confidence: output.confidence,
        lang: output.lang,
        producerVersion: write.opts.adapter.version,
        producedByRun: write.runId,
      });
      representationIds.push(representationId);
    }
    return representationIds;
  }

  /**
   * Mark the run succeeded, then the supersede pass — two-step
   * SELECT-ids → UPDATE $ids (the LET→DELETE id-resolution discipline;
   * 3.2.4 planner class):
   *   * old representations of this (asset, kind) generation point at the
   *     new run's FIRST output of that kind (0059 supersededBy precedent;
   *     one-to-many pairing documented here: ALL old rows point at that
   *     one replacement). Skipped when the run produced no outputs —
   *     there is nothing to point at, and the old generation stays
   *     current.
   *   * old succeeded runs of the same (asset, capability) flip to
   *     'superseded'.
   * Reprocessing NEVER deletes representations — GC owns removal
   * (sweepTenantEvidence's superseded-orphan leg). Representations carry
   * no blobs (content is an inline string), so supersede never touches
   * evidence_blob_gc.
   */
  private async completeRun(
    companyId: string,
    done: { runId: string; opts: ExecuteRunOpts; representationIds: string[] },
  ): Promise<void> {
    const capability = done.opts.adapter.capability;
    const runRef = new StringRecordId(done.runId);
    const outputRefs = done.representationIds.map((rid) => new StringRecordId(rid));
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(
        `UPDATE $id SET status = 'succeeded', finishedAt = time::now(), outputs = $outputs`,
        { id: runRef, outputs: outputRefs },
      );
      if (outputRefs.length > 0) {
        // `NOT IN`, not `NOT INSIDE`: the 3.2.4 parser accepts INSIDE only
        // in the positive form ("Unexpected token INSIDE, expected IN").
        const oldReprIds = await queryRows<unknown>(
          db,
          `SELECT VALUE id FROM derived_representation
            WHERE subjectId = $asset AND kind = $cap
              AND supersededBy IS NONE AND id NOT IN $newIds`,
          { asset: done.opts.assetRecordId, cap: capability, newIds: outputRefs },
        );
        if (oldReprIds.length > 0) {
          await db.query(`UPDATE $ids SET supersededBy = $winner`, {
            ids: oldReprIds,
            winner: outputRefs[0],
          });
        }
      }
      const oldRunIds = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM processing_run
          WHERE assetId = $asset AND capability = $cap AND status = 'succeeded' AND id != $run`,
        { asset: done.opts.assetRecordId, cap: capability, run: runRef },
      );
      if (oldRunIds.length > 0) {
        await db.query(`UPDATE $ids SET status = 'superseded'`, { ids: oldRunIds });
      }
    });
  }

  /** Error text is capped and PII-redacted — it can quote content
   *  derived from personal observations. */
  private async failRun(companyId: string, runId: string, err: unknown): Promise<void> {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactPiiWithReport(raw).text.slice(0, ERROR_MAX);
    this.logger.warn(`processing run ${runId} failed: ${message}`);
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE $id SET status = 'failed', finishedAt = time::now(), error = $e`, {
        id: new StringRecordId(runId),
        e: message,
      }),
    );
  }
}
