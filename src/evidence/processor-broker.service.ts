import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DomainPackManifest } from '../ai/domain-packs';
import { evidenceSubstrateEnabled, processorBrokerEnabled } from '../common/evidence-flags';
import type { DerivedRepresentationKind, EvidenceModality } from '../common/evidence-taxonomy';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { gateProcessorDispatch } from './processing/dispatch-gate';
import {
  EVIDENCE_PROCESSOR_ADAPTERS,
  type ProcessorAdapter,
  type ProcessorAdapterRegistry,
  type ProcessorAssetSnapshot,
  type ProcessorInput,
} from './processing/processor-adapter';
import type { ExecuteRunResult } from './processing/processing-run.service';
import { ProcessingRunService } from './processing/processing-run.service';
import { storageRefScheme } from './storage/storage-adapter';

interface AssetRow {
  id: unknown;
  modality: string;
  mediaType: string;
  availability: string;
  byteLength: number;
  storageRef?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
  quarantineStatus?: string;
  meta?: Record<string, unknown>;
}

interface PackRow {
  manifest: DomainPackManifest;
  acceptedModalities?: unknown;
  acceptedModalitiesChecksum?: unknown;
}

export interface DispatchResult {
  runs: ExecuteRunResult[];
  denied: Array<{ capability: string; reason: string }>;
}

export interface DispatchSweepResult {
  /** Assets considered (1 for a targeted sweep). */
  assets: number;
  /** Assets whose dispatch completed without throwing. */
  dispatched: number;
  /** Total processing runs produced (created OR replayed). */
  runs: number;
  /** Total per-capability denials across the swept assets. */
  denied: number;
  /** Assets whose dispatch threw — logged, never fatal to the sweep. */
  failed: number;
}

/** Default per-call sweep bound; a maintenance verb, not a migration. */
const SWEEP_DEFAULT_LIMIT = 100;
/** Hard bound: one operator call must stay a bounded unit of work. */
const SWEEP_MAX_LIMIT = 1000;

/**
 * EvidenceProcessorBrokerService (0121 MM-1) — the trusted processor
 * broker: matches a pack's DECLARED `memoryModel.processors` needs
 * against the platform's installed adapters and executes them as
 * idempotent processing runs.
 *
 * Two production callers reach it (MM-7 — before that it was
 * service-level only, exercised solely by tests): the blob upload path
 * fires dispatchForPack FIRE-AND-FORGET after an asset registers and
 * scans clean, and the admin maintenance verb calls dispatchSweep to
 * apply a pack over the EXISTING corpus. There is still NO scheduler:
 * both entry points are explicit (see processing-run.service.ts claimRun
 * on why v1 has none).
 *
 * ANTI-DSL: the pack contributes ONLY (modality, produces[]) needs; no
 * pack-supplied endpoint, model, prompt, or code is ever consulted
 * (manifest.ts forbids carrying them in the first place).
 *
 * Default off (EVIDENCE_PROCESSOR_BROKER): dispatch throws 503 BEFORE
 * any query is issued — byte-identical prod.
 */
@Injectable()
export class EvidenceProcessorBrokerService {
  private readonly logger = new Logger(EvidenceProcessorBrokerService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Inject(EVIDENCE_PROCESSOR_ADAPTERS)
    private readonly processors: ProcessorAdapterRegistry,
    private readonly runs: ProcessingRunService,
  ) {}

  async dispatchForPack(
    companyId: string,
    req: { packId: string; assetId: string },
  ): Promise<DispatchResult> {
    if (!processorBrokerEnabled() || !evidenceSubstrateEnabled()) {
      throw new ServiceUnavailableException(
        'EVIDENCE_PROCESSOR_BROKER (with EVIDENCE_SUBSTRATE_ENABLED) is off',
      );
    }
    const { asset, pack } = await this.loadRows(companyId, req);
    const modality = asset.modality as EvidenceModality;
    const capabilities = this.declaredCapabilities(pack.manifest, modality);
    const result: DispatchResult = { runs: [], denied: [] };
    for (const capability of capabilities) {
      const adapter = this.processors.find(
        (candidate) =>
          candidate.capability === capability && candidate.accepts(modality, asset.mediaType),
      );
      if (!adapter) {
        result.denied.push({ capability, reason: 'no installed processor' });
        continue;
      }
      const decision = gateProcessorDispatch({
        manifest: pack.manifest,
        acceptedModalities: pack.acceptedModalities === true,
        acceptedModalitiesChecksum:
          pack.acceptedModalitiesChecksum == null ? null : String(pack.acceptedModalitiesChecksum),
        capability,
        asset: {
          modality,
          availability: asset.availability,
          quarantineStatus: asset.quarantineStatus,
        },
      });
      if (!decision.allowed) {
        result.denied.push({ capability, reason: decision.reason });
        continue;
      }
      const run = await this.runs.execute(companyId, {
        assetRecordId: asset.id,
        packId: req.packId,
        adapter,
        input: this.buildInput(asset, adapter),
      });
      result.runs.push(run);
    }
    return result;
  }

  /**
   * Operator sweep over already-registered assets (the admin maintenance
   * verb). v1 has no scheduler (processing-run.service.ts claimRun), so
   * this is how a pack installed AFTER an asset landed — or a newly
   * installed processor adapter — gets applied to the existing corpus.
   *
   * Bounded and idempotent by construction: each asset goes through the
   * SAME dispatchForPack path, whose runs are keyed deterministically and
   * INSERT IGNORE'd, so re-running the sweep replays instead of
   * duplicating. Per-asset failures are counted, never fatal — one bad
   * blob must not abort an operator's sweep.
   *
   * Candidate selection is a bounded READ (`SELECT VALUE id … LIMIT`) —
   * no DELETE/UPDATE-over-WHERE anywhere near the 3.2.4 planner rule. The
   * per-asset gate ladder (consent, quarantine, tombstone) stays exactly
   * where it is, in gateProcessorDispatch: this method filters nothing
   * itself, it only chooses which ids to hand over.
   */
  async dispatchSweep(
    companyId: string,
    req: { packId: string; assetId?: string | undefined; limit?: number | undefined },
  ): Promise<DispatchSweepResult> {
    if (!processorBrokerEnabled() || !evidenceSubstrateEnabled()) {
      throw new ServiceUnavailableException(
        'EVIDENCE_PROCESSOR_BROKER (with EVIDENCE_SUBSTRATE_ENABLED) is off',
      );
    }
    const assetIds = req.assetId
      ? [req.assetId]
      : await this.sweepCandidates(companyId, req.limit ?? SWEEP_DEFAULT_LIMIT);
    const out: DispatchSweepResult = {
      assets: assetIds.length,
      dispatched: 0,
      runs: 0,
      denied: 0,
      failed: 0,
    };
    for (const assetId of assetIds) {
      try {
        const res = await this.dispatchForPack(companyId, { packId: req.packId, assetId });
        out.dispatched++;
        out.runs += res.runs.length;
        out.denied += res.denied.length;
      } catch (e) {
        out.failed++;
        this.logger.warn(`sweep dispatch failed for ${assetId}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Bounded id read of live (non-tombstoned) assets, oldest ids first. */
  private async sweepCandidates(companyId: string, requested: number): Promise<string[]> {
    const limit = Math.min(Math.max(1, Math.trunc(requested)), SWEEP_MAX_LIMIT);
    const ids = await this.surreal.withCompany(companyId, (db) =>
      queryRows<unknown>(
        db,
        `SELECT VALUE id FROM evidence_asset WHERE availability != 'gone'
          ORDER BY id ASC LIMIT $limit`,
        { limit },
      ),
    );
    return ids.map((id) => String(id));
  }

  private async loadRows(
    companyId: string,
    req: { packId: string; assetId: string },
  ): Promise<{ asset: AssetRow; pack: PackRow }> {
    const { asset, pack } = await this.surreal.withCompany(companyId, async (db) => {
      const assetRow = await queryFirst<AssetRow>(
        db,
        `SELECT * FROM type::record('evidence_asset', $tail) LIMIT 1`,
        { tail: idTailOf(req.assetId) },
      );
      // Direct row read — no admin-module import, no DI cycle.
      const packRow = await queryFirst<PackRow>(
        db,
        `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum
           FROM domain_pack WHERE packId = $p LIMIT 1`,
        { p: req.packId },
      );
      return { asset: assetRow, pack: packRow };
    });
    if (!asset) throw new NotFoundException(`asset ${req.assetId} not found`);
    if (!pack) throw new NotFoundException(`pack ${req.packId} is not installed`);
    return { asset, pack };
  }

  /** The pack's declared representation needs for this modality, deduped
   *  in declaration order. */
  private declaredCapabilities(
    manifest: DomainPackManifest,
    modality: EvidenceModality,
  ): DerivedRepresentationKind[] {
    const kinds: DerivedRepresentationKind[] = [];
    for (const processor of manifest.memoryModel?.processors ?? []) {
      if (processor.modality !== modality) continue;
      for (const kind of processor.produces) {
        if (!kinds.includes(kind)) kinds.push(kind);
      }
    }
    return kinds;
  }

  /** openStream only for hot, adapter-resolvable blobs; null otherwise
   *  (metadata-only adapters run either way). */
  private buildInput(asset: AssetRow, _adapter: ProcessorAdapter): ProcessorInput {
    const snapshot: ProcessorAssetSnapshot = {
      id: asset.id,
      modality: asset.modality as EvidenceModality,
      mediaType: asset.mediaType,
      availability: asset.availability,
      byteLength: asset.byteLength,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      pageCount: asset.pageCount,
      meta: asset.meta,
    };
    const ref = asset.storageRef;
    if (asset.availability !== 'hot' || !ref) return { asset: snapshot, openStream: null };
    const scheme = storageRefScheme(ref);
    const storage = scheme ? this.runs.storageAdapters.get(scheme) : undefined;
    if (!storage) return { asset: snapshot, openStream: null };
    return { asset: snapshot, openStream: () => storage.get(ref) };
  }
}
