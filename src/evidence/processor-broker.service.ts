import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DomainPackManifest } from '../ai/domain-packs';
import { evidenceSubstrateEnabled, processorBrokerEnabled } from '../common/evidence-flags';
import type { DerivedRepresentationKind, EvidenceModality } from '../common/evidence-taxonomy';
import { SurrealService, queryFirst } from '../db/surreal.service';
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

/**
 * EvidenceProcessorBrokerService (0121 MM-1) — the trusted processor
 * broker: matches a pack's DECLARED `memoryModel.processors` needs
 * against the platform's installed adapters and executes them as
 * idempotent processing runs. Service-level only — no HTTP controller,
 * no scheduler, no ingest surface (sibling PR-C doctrine from 0109:
 * tests and future PRs call the service directly).
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
