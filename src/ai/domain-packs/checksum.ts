import { createHash } from 'node:crypto';
import type { DomainPackManifest } from './manifest';

/**
 * Content integrity for distributed packs (docs/domain-packs.md). A pack's
 * checksum is the sha256 of its manifest in CANONICAL form (recursively
 * key-sorted JSON), so two byte-different-but-equivalent manifests hash the
 * same. On install a caller may pass an expectedChecksum; the server rejects a
 * mismatch — "the manifest I install is the one I reviewed". (Publisher
 * signatures are a further step; this is the integrity primitive.)
 */
export function packChecksum(manifest: DomainPackManifest): string {
  return createHash('sha256').update(canonicalize(manifest)).digest('hex');
}

/** Canonical (recursively key-sorted) JSON string of any value. Shared by the
 *  checksum and the signature (which signs the manifest minus its own sig). */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
