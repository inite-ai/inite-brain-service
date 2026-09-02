import type { Readable } from 'node:stream';

/**
 * EvidenceStorageAdapter — the blob-side contract of the evidence
 * substrate (Brain v2.1 M1). Bytes NEVER live in the DB (0109 doctrine);
 * an evidence_asset row points at its blob through `storageRef`, an
 * adapter-scheme URI (`<scheme>://…`) resolved against the registry
 * below. v1 ships ONE adapter (fs); an s3-class adapter is a new scheme
 * + registry entry, zero row changes.
 *
 * Contract points:
 *   * put() is CONTENT-ADDRESSED and idempotent: the blob's location is a
 *     pure function of (companyId, byteHash), so re-putting identical
 *     bytes lands on the same ref and is a no-op. Paired with the
 *     evidence_asset_hash_idx UNIQUE row invariant this keeps row↔blob
 *     1:1 — deleting one row's blob can never orphan another row's.
 *   * delete() returns whether a blob existed — the GDPR cascade and the
 *     retention/reconciliation sweeps log honest counts.
 *   * All methods throw a clear error when the adapter is unconfigured
 *     (e.g. EVIDENCE_FS_ROOT unset) — fail loud, never a silent default
 *     path.
 */
export interface EvidenceStorageAdapter {
  /** URI scheme this adapter owns ('fs'). */
  readonly scheme: string;
  /** Store bytes content-addressed; idempotent on identical bytes. */
  put(
    companyId: string,
    byteHash: string,
    data: Buffer,
  ): Promise<{ storageRef: string; byteLength: number }>;
  /** True only when this ref is structurally owned by the calling tenant. */
  belongsToTenant(companyId: string, storageRef: string): boolean;
  /** Stream the blob back; throws when the ref is invalid or missing. */
  get(storageRef: string): Promise<Readable>;
  /** Blob metadata without reading it; null when absent. */
  head(storageRef: string): Promise<{ byteLength: number } | null>;
  exists(storageRef: string): Promise<boolean>;
  /** Remove the blob; true when something was deleted. */
  delete(storageRef: string): Promise<boolean>;
  /**
   * OPTIONAL (0121 MM-6 extension point — existing third-party
   * implementations keep compiling): KMS/at-rest-encryption context for
   * this blob; null = adapter-native or none. An s3-class adapter
   * returns its key reference here so audits can prove at-rest coverage
   * without reading bytes.
   */
  encryptionContext?(storageRef: string): Promise<{ kmsKeyRef: string } | null>;
  /**
   * OPTIONAL (0121 MM-6 extension point): short-lived signed GET URL for
   * out-of-process readers; null = unsupported. Serving through this is
   * separately gated per call (raw-evidence-gate.ts) — the adapter only
   * answers CAN it mint one.
   */
  signedGetUrl?(storageRef: string, ttlSeconds: number): Promise<string | null>;
}

/**
 * DI token for the scheme registry: Map<scheme, adapter>, assembled in
 * evidence.module.ts. Injected (not imported) so tests can hand the
 * store service an in-memory adapter and future adapters register
 * without touching consumers.
 */
export const EVIDENCE_STORAGE_ADAPTERS = Symbol('EVIDENCE_STORAGE_ADAPTERS');

export type EvidenceStorageRegistry = ReadonlyMap<string, EvidenceStorageAdapter>;

/** Scheme of a storageRef URI ('fs://…' → 'fs'); null when malformed. */
export function storageRefScheme(storageRef: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(storageRef);
  return m ? m[1]! : null;
}
