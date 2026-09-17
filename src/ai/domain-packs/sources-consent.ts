import { createHash } from 'node:crypto';
import { canonicalJson } from './checksum';
import type { DomainPackManifest, PackMcpHttpSourceSpec, PackSourceSpec } from './manifest';

/**
 * Install-time consent for the manifest's `sources` section — the
 * mcp-consent.ts mold, verbatim in shape. A pack that declares sources
 * says WHERE it wants to read from: an `mcp`/`http` entry means signed
 * outbound calls to a publisher's server, a `native` entry names a
 * platform connector the operator will point at their own paths and
 * buckets. That must be an explicit operator decision, not a side effect
 * of installing an ontology. Consent is recorded WITH a checksum of the
 * section (canonical JSON), so an upgrade that changes it re-requires
 * the flag while an upgrade that leaves it untouched carries the prior
 * consent over.
 *
 * Nothing in the section is live until a `source_connection` exists —
 * consent here is the review of what MAY be connected.
 */

/** sha256 hex of the canonical sources section; null when absent/empty. */
export function sourcesChecksum(manifest: DomainPackManifest): string | null {
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) return null;
  return createHash('sha256').update(canonicalJson(manifest.sources)).digest('hex');
}

/** The manifest's egress-bearing sources (empty when none declared). */
export function httpMcpSources(manifest: DomainPackManifest): PackMcpHttpSourceSpec[] {
  return (manifest.sources ?? []).filter(
    (s): s is PackMcpHttpSourceSpec => s.kind === 'mcp' && s.transport === 'http',
  );
}

/** Whether any declared source wants the per-install secret as its bearer. */
export function wantsInstallSecret(manifest: DomainPackManifest): boolean {
  return httpMcpSources(manifest).some((s) => s.auth === 'install_secret');
}

function describe(s: PackSourceSpec): string {
  if (s.kind === 'mcp') {
    return s.transport === 'http'
      ? `mcp "${s.id}" → ${s.url ?? 'a server the operator names'} (${s.auth}, ${s.shape})`
      : `mcp "${s.id}" via stdio "${s.command}" (${s.shape})`;
  }
  if (s.kind === 'native') return `native "${s.id}" (${s.connector}, ${s.shape})`;
  return `external "${s.id}" (${s.shape})`;
}

/**
 * Decide whether this install/upgrade needs the `acceptSources` flag.
 * Returns the client-facing refusal message (listing every source's
 * id/kind/target so the operator reviews exactly what they accept), or
 * null when consent is granted or not required.
 */
export function sourcesConsentRequired(opts: {
  manifest: DomainPackManifest;
  acceptSources: boolean | undefined;
  /** Prior row state — pass false/null on a fresh install. */
  priorAccepted: boolean;
  priorChecksum: string | null;
}): string | null {
  const checksum = sourcesChecksum(opts.manifest);
  if (!checksum) return null;
  if (opts.acceptSources === true) return null;
  if (opts.priorAccepted && opts.priorChecksum === checksum) return null;
  const listing = (opts.manifest.sources ?? []).map(describe).join('; ');
  return (
    `pack "${opts.manifest.id}" v${opts.manifest.version} declares ` +
    `${opts.manifest.sources?.length} source(s): ${listing}. ` +
    `Review them and repeat the install with acceptSources: true.`
  );
}
