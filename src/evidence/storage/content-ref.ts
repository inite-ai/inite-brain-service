/**
 * The content-addressed storageRef grammar every blob adapter shares:
 * `<scheme>://<companyId>/<byteHash>`. The tenant id must match the
 * conservative shape the fixture/auth layer mints (co_…) and the hash
 * must be 64 lowercase hex chars, so neither segment can carry a path
 * escape or a key delimiter — one fence for a directory tree and for a
 * bucket key, so a second adapter cannot relax it by accident. The
 * store's own location (root directory, bucket, prefix) is NEVER part of
 * the ref: an operator relocates a store by changing configuration, not
 * by rewriting rows.
 */
export const HASH_RE = /^[0-9a-f]{64}$/;
export const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Parsed, validated pieces of a content-addressed storageRef. */
export interface ParsedContentRef {
  companyId: string;
  byteHash: string;
}

/**
 * Parse + validate `<scheme>://<companyId>/<byteHash>`. Pure and
 * unit-testable. Returns null on ANY deviation (wrong scheme, extra
 * segment, empty tenant, a hash that is not 64 lowercase hex); callers
 * treat null as a hard error, never a guess.
 */
export function parseContentRef(scheme: string, storageRef: string): ParsedContentRef | null {
  const prefix = `${scheme}://`;
  if (!storageRef.startsWith(prefix)) return null;
  const parts = storageRef.slice(prefix.length).split('/');
  if (parts.length !== 2) return null;
  const [companyId, byteHash] = parts as [string, string];
  if (!TENANT_RE.test(companyId) || !HASH_RE.test(byteHash)) return null;
  return { companyId, byteHash };
}
