import { Injectable, Logger } from '@nestjs/common';

/**
 * EvidenceScanHook — the quarantine seam's scanner contract (0121 MM-6).
 * A real virus/content scanner is an infra follow-up behind its own key;
 * v1 ships the allow-all stub below so the quarantined → scanning →
 * clean|rejected lifecycle is exercised end-to-end. The hook sees row
 * METADATA only (never bytes) — a byte-scanning implementation resolves
 * the blob itself through the storage-adapter registry.
 */
export interface EvidenceScanTarget {
  id: string;
  modality: string;
  mediaType: string;
  byteLength: number;
  storageRef?: string | undefined;
}

export interface EvidenceScanHook {
  readonly name: string;
  scan(asset: EvidenceScanTarget): Promise<'clean' | 'rejected'>;
}

/** DI token — evidence.module.ts binds the stub; tests override it. */
export const EVIDENCE_SCAN_HOOK = Symbol('EVIDENCE_SCAN_HOOK');

/**
 * Allow-all STUB: every asset scans 'clean'. Warns ONCE per boot (an
 * operator enabling EVIDENCE_QUARANTINE must know no real scanner is
 * installed) and logs each pass at debug.
 */
@Injectable()
export class AllowAllScanHook implements EvidenceScanHook {
  readonly name = 'allow-all-stub';
  private readonly logger = new Logger(AllowAllScanHook.name);
  private warnedOnce = false;

  scan(asset: EvidenceScanTarget): Promise<'clean' | 'rejected'> {
    if (!this.warnedOnce) {
      this.warnedOnce = true;
      this.logger.warn(
        'evidence scan hook is the allow-all STUB — every asset scans clean; ' +
          'install a real scanner before trusting external ingest in production',
      );
    }
    this.logger.debug(`scan allow-all: ${asset.id}`);
    return Promise.resolve('clean');
  }
}
