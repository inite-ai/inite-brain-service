import type { Readable } from 'node:stream';

/**
 * EvidenceStorageAdapter — the blob-side contract of the evidence
 * substrate (Brain v2.1 M1). Bytes NEVER live in the DB (0109 doctrine);
 * an evidence_asset row points at its blob through `storageRef`, an
 * adapter-scheme URI (`<scheme>://…`) resolved against the registry
 * below. Two adapters ship — fs (local disk) and s3 (the shared object
 * store for N replicas); a further adapter is a new scheme + registry
 * entry, zero row changes.
 *
 * Contract points:
 *   * put() is CONTENT-ADDRESSED and idempotent: the blob's location is a
 *     pure function of (companyId, byteHash), so re-putting identical
 *     bytes lands on the same ref and is a no-op. The
 *     evidence_asset_hash_idx UNIQUE invariant means one row per byte
 *     stream, so the COMMON case is row↔blob 1:1 — but it is not a
 *     guarantee the delete side may lean on: registerAsset accepts an
 *     explicit storageRef whose hash is not the row's own byteHash, so a
 *     blob can back MORE THAN ONE row. Every deletion path must therefore
 *     answer "does any row still point here?", never "is this row's hash
 *     mine?" (see listBlobs and orphan-blob-gc.service.ts).
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
  /**
   * OPTIONAL (orphan-GC extension point — existing third-party
   * implementations keep compiling): enumerate the blobs this adapter
   * holds FOR ONE TENANT, oldest-first is not required but stable
   * iteration is. Streamed (AsyncIterable), never materialised: a store
   * can hold more blobs than fit in one array.
   *
   * TWO CONTRACT POINTS, both load-bearing for the orphan sweep, which
   * is the only caller and which DELETES what this yields:
   *   1. TENANT SCOPING IS THE ADAPTER'S PROMISE. Every yielded ref MUST
   *      satisfy `belongsToTenant(companyId, ref)`. An adapter whose
   *      addressing cannot separate tenants (a flat bucket with no tenant
   *      segment) MUST NOT implement this method — leaving it undefined
   *      makes the sweep skip the scheme entirely, which is the safe
   *      outcome. The sweep re-checks belongsToTenant per entry anyway,
   *      but that is defence in depth, not the primary fence.
   *   2. AGE IS WHEN THE BYTES WERE WRITTEN. `modifiedAtMs` gates the
   *      grace window that protects an upload whose bytes are already
   *      stored and whose row does not exist yet. An adapter that cannot
   *      date a blob exactly must err YOUNGER: reporting a blob as older
   *      than it is deletes live uploads, while reporting it younger only
   *      defers a sweep. It must NOT, however, fold in timestamps that
   *      move for unrelated reasons (a metadata touch, a restore) — that
   *      is not conservatism, it is a store that can silently read as
   *      entirely fresh forever.
   *
   * A missing tenant partition is an empty iteration, never a throw.
   */
  listBlobs?(companyId: string): AsyncIterable<StoredBlobEntry>;
  /**
   * OPTIONAL (orphan-GC extension point): drop this tenant's PARTIAL
   * WRITE artefacts older than `olderThanMs` — the fs adapter's
   * `.tmp-<uuid>` stragglers from a process killed between write and
   * rename, an s3-class adapter's abandoned multipart uploads. Such
   * artefacts are not addressable by any storageRef, so no row can
   * reference them and listBlobs cannot enumerate them: they are
   * unreachable garbage by construction, which is exactly why they need
   * their own broom.
   *
   * `dryRun` reports what WOULD go without removing anything — the sweep
   * runs report-only in its first stage and this leg must honour that.
   */
  sweepIncompleteWrites?(
    companyId: string,
    opts: { olderThanMs: number; dryRun: boolean },
  ): Promise<{ found: number; removed: number }>;
  /**
   * OPTIONAL (multi-replica readiness): one round trip proving the
   * backing store is reachable, the credentials authorize, and the
   * configured partition exists — HeadBucket for an s3-class adapter.
   * Resolves when the store can serve; throws an operator-actionable
   * message otherwise. `/ready` and the `evidence_store` capability
   * probe call it on the SELECTED adapter (EVIDENCE_STORAGE_SCHEME); an
   * adapter with no remote dependency leaves it undefined and readiness
   * treats the check as vacuously satisfied.
   */
  probe?(): Promise<void>;
}

/**
 * One stored blob as the orphan sweep sees it: its ref (the join key
 * against evidence_asset.storageRef), its size (so a report can state
 * how much a run would reclaim), and when the store last touched it (the
 * grace-window input — see the listBlobs contract).
 */
export interface StoredBlobEntry {
  storageRef: string;
  byteLength: number;
  modifiedAtMs: number;
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
