import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  BUILTIN_PACKS,
  sourcesChecksum,
  type DomainPackManifest,
  type PackSourceSpec,
} from '../ai/domain-packs';
import { sourceEgressAllowPrivate, sourceFsRoots } from '../common/source-plane-flags';
import { SurrealService, queryRows } from '../db/surreal.service';
import type {
  SourceAvailability,
  SourceCatalogEntry,
  SourceCatalogResponse,
  SourceConnectorState,
} from '../contracts/source-plane/source-plane.schema';
import {
  SOURCE_CONNECTORS,
  connectorState,
  type Connector,
  type ConnectorRegistry,
} from './connector';
import { connectorKindOf } from './source-connection.service';

/** The domain_pack columns the catalogue reads. */
interface InstalledPackRow {
  manifest?: DomainPackManifest;
  acceptedSources?: unknown;
  acceptedSourcesChecksum?: unknown;
}

/**
 * The connectable catalogue — what an operator can point the brain at
 * on THIS deployment, for THIS tenant. It joins three things that are
 * otherwise only discoverable by reading manifests and env: the
 * `sources` sections of the packs the tenant has (builtin ones seeded
 * globally, installed ones from `domain_pack` with their consent
 * state), the connectors this build ships and whether their switch is
 * on, and the two operator fences a connection has to fit inside (the
 * `fs` root jail, the private-egress opt-in).
 *
 * Read-only and cheap: one SELECT plus in-memory joins. It never runs a
 * connector and never reveals a credential — `configExample` is the
 * connector's static self-description.
 */
@Injectable()
export class SourceCatalogService {
  constructor(
    private readonly surreal: SurrealService,
    @Optional() @Inject(SOURCE_CONNECTORS) private readonly connectors?: ConnectorRegistry,
  ) {}

  async catalog(companyId: string): Promise<SourceCatalogResponse> {
    const registry = this.connectors ?? [];
    const sources: SourceCatalogEntry[] = [];
    for (const pack of BUILTIN_PACKS) {
      sources.push(...this.entriesOf(registry, pack, { builtin: true, accepted: true }));
    }
    const installed = await this.surreal.withCompany(companyId, (db) =>
      queryRows<InstalledPackRow>(
        db,
        `SELECT manifest, acceptedSources, acceptedSourcesChecksum FROM domain_pack WHERE status = 'active'`,
      ),
    );
    for (const row of installed) {
      const manifest = row.manifest;
      if (!manifest || BUILTIN_PACKS.some((p) => p.id === manifest.id)) continue;
      const checksum = sourcesChecksum(manifest);
      const accepted =
        checksum === null ||
        (row.acceptedSources === true && String(row.acceptedSourcesChecksum ?? '') === checksum);
      sources.push(...this.entriesOf(registry, manifest, { builtin: false, accepted }));
    }
    return {
      sources,
      connectors: registry.map(describeConnector),
      fsRoots: sourceFsRoots(),
      egressAllowPrivate: sourceEgressAllowPrivate(),
    };
  }

  private entriesOf(
    registry: ConnectorRegistry,
    manifest: DomainPackManifest,
    flags: { builtin: boolean; accepted: boolean },
  ): SourceCatalogEntry[] {
    return (manifest.sources ?? []).map((entry) => {
      const kind = connectorKindOf(entry);
      const state = availabilityOf(registry, entry);
      const connector = typeof state.connector === 'string' ? null : state.connector;
      return {
        packId: manifest.id,
        packVersion: manifest.version,
        builtin: flags.builtin,
        accepted: flags.accepted,
        sourceId: entry.id,
        kind: entry.kind,
        connector: kind,
        shape: entry.shape,
        title: entry.title ?? null,
        description: entry.description ?? null,
        defaults: {
          contentPolicy: entry.defaults?.contentPolicy ?? 'text',
          deletePolicy: entry.defaults?.deletePolicy ?? 'close',
          schedule: entry.defaults?.schedule ?? 'manual',
        },
        availability: state.availability,
        configExample: connector?.configExample ?? null,
        credentialHint: connector?.credentialHint ?? null,
      };
    });
  }
}

/** Natives that exist on the local agent only — git never runs in the brain process. */
const AGENT_ONLY_CONNECTORS = new Set(['git']);

function availabilityOf(
  registry: ConnectorRegistry,
  entry: PackSourceSpec,
): { availability: SourceAvailability; connector: Connector | 'missing' | 'disabled' } {
  if (entry.kind === 'external') return { availability: 'external', connector: 'missing' };
  if (entry.kind === 'mcp' && entry.transport === 'stdio') {
    return { availability: 'agent', connector: 'missing' };
  }
  if (entry.kind === 'native' && AGENT_ONLY_CONNECTORS.has(entry.connector)) {
    return { availability: 'agent', connector: 'missing' };
  }
  const state = connectorState(registry, connectorKindOf(entry));
  if (typeof state === 'string') return { availability: state, connector: state };
  return { availability: 'ready', connector: state };
}

function describeConnector(c: Connector): SourceConnectorState {
  return {
    kind: c.kind,
    state: c.enabled === undefined || c.enabled() ? 'ready' : 'disabled',
    flag: `SOURCE_KIND_${c.kind.toUpperCase()}`,
  };
}
