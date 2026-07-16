import { createHash } from 'node:crypto';
import { canonicalJson } from './checksum';
import type {
  DomainPackManifest,
  PackExternalToolSpec,
} from './manifest';

/**
 * Install-time consent for pack-declared MCP tools (docs/mcp-pack-tools.md).
 *
 * A pack that ships mcpTools changes the tenant's agent surface (new tool
 * names/descriptions in every MCP client) and — for external tools —
 * causes signed outbound calls to a publisher endpoint. That must be an
 * explicit operator decision, not a side effect of installing an
 * ontology. Consent is recorded WITH a checksum of the mcpTools section
 * (canonical JSON, same primitive as packChecksum) so an upgrade that
 * changes the section re-requires the flag, while an upgrade that leaves
 * it untouched carries the prior consent over.
 *
 * Pure helpers — DomainPackInstallService owns the DB row and maps the
 * returned message to a 400.
 */

/** sha256 hex of the canonical mcpTools section; null when absent/empty. */
export function mcpToolsChecksum(manifest: DomainPackManifest): string | null {
  if (!Array.isArray(manifest.mcpTools) || manifest.mcpTools.length === 0) {
    return null;
  }
  return createHash('sha256')
    .update(canonicalJson(manifest.mcpTools))
    .digest('hex');
}

/** The manifest's external mcpTools (empty array when none declared). */
export function externalMcpTools(
  manifest: DomainPackManifest,
): PackExternalToolSpec[] {
  return (manifest.mcpTools ?? []).filter(
    (t): t is PackExternalToolSpec => t.kind === 'external',
  );
}

/**
 * Decide whether this install/upgrade needs the `acceptMcpTools` flag.
 * Returns the client-facing refusal message (listing every tool's
 * name/kind/endpoint so the operator reviews exactly what they accept),
 * or null when consent is granted or not required.
 */
export function mcpConsentRequired(opts: {
  manifest: DomainPackManifest;
  acceptMcpTools: boolean | undefined;
  /** Prior row state — pass false/null on a fresh install. */
  priorAccepted: boolean;
  priorChecksum: string | null;
}): string | null {
  const checksum = mcpToolsChecksum(opts.manifest);
  if (!checksum) return null; // no tools declared — nothing to consent to
  if (opts.acceptMcpTools === true) return null;
  if (opts.priorAccepted && opts.priorChecksum === checksum) return null;
  const listing = (opts.manifest.mcpTools ?? [])
    .map((t) =>
      t.kind === 'external'
        ? `external "${t.name}" → ${t.endpoint}`
        : `query "${t.name}" (${t.query.surface})`,
    )
    .join('; ');
  return (
    `pack "${opts.manifest.id}" v${opts.manifest.version} declares ` +
    `${opts.manifest.mcpTools?.length} MCP tool(s): ${listing}. ` +
    `Review them and repeat the install with acceptMcpTools: true.`
  );
}
