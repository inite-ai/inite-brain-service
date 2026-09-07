import { Inject, Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryFirst, queryRows } from '../../db/surreal.service';
import { evidenceDerivedMaxBytes } from '../../common/evidence-flags';
import type { DerivedRepresentationKind } from '../../common/evidence-taxonomy';
import { idTailOf, redactPiiWithReport } from '../../ingest/ingest-utils';
import { EvidenceStoreService } from '../evidence-store.service';
import { locatorDedupKey } from '../locator';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageRegistry,
} from '../storage/storage-adapter';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from './processor-adapter';
import { processingRunIdTail, processorConfigFingerprint } from './processor-fingerprint';

const ERROR_MAX = 500;
/**
 * How many text-bearing outputs of ONE run may ask the write seam for an
 * embedding. A region-wise OCR pass over a 400-page PDF legitimately
 * emits thousands of outputs; without a cap a single dispatch would fan
 * out thousands of model calls. The first 32 are the ones a retrieval
 * vector buys anything for (the lane renders 4 lines), the rest land as
 * text-only rows that the BM25 leg still serves — and a later run under
 * a bumped version re-offers them. Deliberately NOT an env knob until
 * the dense leg is measured (the FRAGMENT_LANE_TOP_K precedent).
 */
const EMBED_OUTPUTS_PER_RUN_MAX = 32;

/** Subjects a run's outputs were attached to, plus the written rows. */
interface WriteOutcome {
  representationIds: string[];
  /** Distinct record ids (asset + any fragments) — the supersede scope. */
  subjectIds: unknown[];
}

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
      const written = await this.writeOutputs(companyId, { runId, opts, outputs });
      await this.completeRun(companyId, { runId, opts, written });
      return {
        runId,
        capability: adapter.capability,
        status: 'succeeded',
        representationIds: written.representationIds,
      };
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

  /**
   * Write outputs through the ONE write seam, with lineage.
   *
   * FRAGMENT-BEARING (the point of this pass): a locator-bearing output
   * is anchored to the evidence_fragment for its span and stored with
   * `subjectKind: 'fragment'` — the ONLY shape the serving fragment lane
   * can return, since that lane filters `subjectKind = 'fragment'`. A
   * locator-less output keeps today's asset-level row, byte-identical:
   * an adapter that describes the whole asset says so by emitting no
   * locator, and nothing about its rows changes.
   *
   * EMBEDDINGS: text-bearing outputs ask the seam for a vector, capped
   * at EMBED_OUTPUTS_PER_RUN_MAX per run (the seam decides whether any
   * model call actually happens — EVIDENCE_FRAGMENT_EMBEDDINGS). The
   * budget lives HERE because a run is the unit that can fan out.
   */
  private async writeOutputs(
    companyId: string,
    write: { runId: string; opts: ExecuteRunOpts; outputs: ProcessorOutput[] },
  ): Promise<WriteOutcome> {
    const representationIds: string[] = [];
    // The asset is ALWAYS a supersede subject (see completeRun) — a run
    // that moves from asset-level to fragment-level outputs must still
    // retire the generation it replaces.
    const subjects = new Map<string, unknown>([
      [String(write.opts.assetRecordId), write.opts.assetRecordId],
    ]);
    let embedBudget = EMBED_OUTPUTS_PER_RUN_MAX;
    for (const output of write.outputs) {
      const subject = await this.subjectFor(companyId, write.opts, output);
      if (subject.kind === 'fragment') subjects.set(subject.id, new StringRecordId(subject.id));
      const embedContent = (output.content ?? '').trim() !== '' && embedBudget > 0;
      if (embedContent) embedBudget--;
      const { representationId } = await this.store.addRepresentation(companyId, {
        subjectId: subject.id,
        subjectKind: subject.kind,
        kind: output.kind,
        content: output.content,
        confidence: output.confidence,
        lang: output.lang,
        producerVersion: write.opts.adapter.version,
        producedByRun: write.runId,
        embedContent,
      });
      representationIds.push(representationId);
    }
    return { representationIds, subjectIds: [...subjects.values()] };
  }

  /**
   * The subject one output hangs off. A locator names a sub-asset span,
   * so the fragment for it is created ONCE and reused on every re-run:
   * the dedup key is the LOCATOR's identity (not the processor's), so a
   * bumped adapter version re-detecting the same region attaches its new
   * representation to the SAME citation target instead of forking a
   * second one. The fragment inherits the asset's media classification
   * — a processor is not a PII classifier, and a derived span is never
   * cleaner than the asset it came from.
   */
  private async subjectFor(
    companyId: string,
    opts: ExecuteRunOpts,
    output: ProcessorOutput,
  ): Promise<{ id: string; kind: 'asset' | 'fragment' }> {
    const assetId = String(opts.assetRecordId);
    if (output.locator === undefined) return { id: assetId, kind: 'asset' };
    const locator = { ...output.locator } as Record<string, unknown>;
    const { fragmentId } = await this.store.addFragment(companyId, {
      assetId,
      locator,
      label: output.label,
      dedupKey: locatorDedupKey(locator),
      inheritAssetPii: true,
    });
    return { id: fragmentId, kind: 'fragment' };
  }

  /**
   * Mark the run succeeded, then the supersede pass — two-step
   * SELECT-ids → UPDATE $ids (the LET→DELETE id-resolution discipline;
   * 3.2.4 planner class):
   *   * old representations of this (subject, kind) generation point at
   *     the new run's FIRST output of that kind (0059 supersededBy
   *     precedent; one-to-many pairing documented here: ALL old rows
   *     point at that one replacement). Skipped when the run produced no
   *     outputs — there is nothing to point at, and the old generation
   *     stays current. The SUBJECT SET is the asset plus every fragment
   *     this run attached to (`subjectId INSIDE`, the
   *     purgeRepresentationBatches shape): a locator-less run has the
   *     asset alone and behaves exactly as before, while a fragment-
   *     bearing one retires both the asset-level generation it replaces
   *     and the previous generation on each span it re-detected. A
   *     fragment whose span the new generation NO LONGER finds keeps its
   *     old representation — there is no replacement to point it at, and
   *     inventing one would attach another span's text to it; it dies
   *     with its asset, or is retired when a later run re-detects it.
   *   * old succeeded runs of the same (asset, capability) flip to
   *     'superseded'.
   * Reprocessing NEVER deletes representations — GC owns removal
   * (sweepTenantEvidence's superseded-orphan leg). Representations carry
   * no blobs (content is an inline string), so supersede never touches
   * evidence_blob_gc.
   */
  private async completeRun(
    companyId: string,
    done: { runId: string; opts: ExecuteRunOpts; written: WriteOutcome },
  ): Promise<void> {
    const capability = done.opts.adapter.capability;
    const runRef = new StringRecordId(done.runId);
    const outputRefs = done.written.representationIds.map((rid) => new StringRecordId(rid));
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
            WHERE subjectId INSIDE $subjects AND kind = $cap
              AND supersededBy IS NONE AND id NOT IN $newIds`,
          { subjects: done.written.subjectIds, cap: capability, newIds: outputRefs },
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
