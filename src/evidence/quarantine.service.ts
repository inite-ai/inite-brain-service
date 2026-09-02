import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { evidenceQuarantineEnabled, evidenceSubstrateEnabled } from '../common/evidence-flags';
import { SurrealService, queryFirst } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { EvidenceStoreService } from './evidence-store.service';
import { EVIDENCE_SCAN_HOOK, type EvidenceScanHook } from './processing/scan-hook';

interface QuarantinedAssetRow {
  id: unknown;
  modality: string;
  mediaType: string;
  byteLength: number;
  storageRef?: string;
  quarantineStatus?: string;
}

/**
 * EvidenceQuarantineService (0121 MM-6) — the external-ingest safety
 * seam's scan lifecycle: quarantined → scanning → (hook verdict) →
 * clean | rejected.
 *
 * 'rejected' reuses the RETENTION tombstone path (0048 'purged'
 * precedent): availability='gone' + quarantineStatus='rejected',
 * dependents purged, blob deleted best-effort — a failed blob delete
 * KEEPS storageRef so reconcileGoneBlobs retries next sweep (no new
 * evidence_blob_gc reason; the 0114 enum stays untouched). The header
 * row survives as a tombstone.
 *
 * A hook that THROWS leaves the asset 'scanning' — still dispatch-denied
 * (fail closed) and re-scannable.
 *
 * Gated on EVIDENCE_QUARANTINE + EVIDENCE_SUBSTRATE_ENABLED (503 off) —
 * the transition WRITES a row field; erasure legs live in the store
 * service and stay flag-independent.
 */
@Injectable()
export class EvidenceQuarantineService {
  private readonly logger = new Logger(EvidenceQuarantineService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly store: EvidenceStoreService,
    @Inject(EVIDENCE_SCAN_HOOK) private readonly hook: EvidenceScanHook,
  ) {}

  async runScan(
    companyId: string,
    assetId: string,
  ): Promise<{ assetId: string; quarantineStatus: 'clean' | 'rejected' }> {
    if (!evidenceQuarantineEnabled() || !evidenceSubstrateEnabled()) {
      throw new ServiceUnavailableException(
        'EVIDENCE_QUARANTINE (with EVIDENCE_SUBSTRATE_ENABLED) is off',
      );
    }
    const asset = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<QuarantinedAssetRow>(
        db,
        `SELECT id, modality, mediaType, byteLength, storageRef, quarantineStatus
           FROM type::record('evidence_asset', $tail) LIMIT 1`,
        { tail: idTailOf(assetId) },
      ),
    );
    if (!asset) throw new NotFoundException(`asset ${assetId} not found`);
    const current = asset.quarantineStatus;
    // Terminal states are idempotent no-ops; a never-quarantined row
    // (legacy/internal) has nothing to scan.
    if (current === 'clean') return { assetId, quarantineStatus: 'clean' };
    if (current === 'rejected') return { assetId, quarantineStatus: 'rejected' };
    if (current !== 'quarantined' && current !== 'scanning') {
      throw new ConflictException(`asset ${assetId} is not quarantined`);
    }
    await this.setStatus(companyId, asset.id, 'scanning');
    const verdict = await this.hook.scan({
      id: String(asset.id),
      modality: asset.modality,
      mediaType: asset.mediaType,
      byteLength: asset.byteLength,
      storageRef: asset.storageRef,
    });
    if (verdict === 'clean') {
      await this.setStatus(companyId, asset.id, 'clean');
      return { assetId, quarantineStatus: 'clean' };
    }
    // Close the write gate first (both stamps), then purge — a crash
    // mid-purge leaves a 'gone' row the reconciliation leg resumes.
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE $id SET quarantineStatus = 'rejected', availability = 'gone'`, {
        id: asset.id,
      }),
    );
    const { blobDeleted } = await this.store.tombstoneAssetBytes(companyId, assetId);
    this.logger.warn(
      `quarantine rejected ${assetId} (hook=${this.hook.name}): tombstoned, blobDeleted=${String(blobDeleted)}`,
    );
    return { assetId, quarantineStatus: 'rejected' };
  }

  private async setStatus(
    companyId: string,
    assetRecordId: unknown,
    status: 'scanning' | 'clean',
  ): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE $id SET quarantineStatus = $s`, { id: assetRecordId, s: status }),
    );
  }
}
