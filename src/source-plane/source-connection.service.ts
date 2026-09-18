import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import {
  BUILTIN_PACKS,
  sourcesChecksum,
  type DomainPackManifest,
  type PackMcpHttpSourceSpec,
  type PackSourceSpec,
} from '../ai/domain-packs';
import { assertPublicHttpUrl, EgressDeniedError } from '../common/egress-guard';
import { sourceEgressAllowPrivate } from '../common/source-plane-flags';
import { scopeForUser } from '../auth/scope-tags';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { SourcesService } from '../sources/sources.service';
import type { SourceType } from '../contracts/sources/sources.schema';
import {
  AGENT_HOST,
  grantIdOfCredential,
  type CreateSourceConnectionRequest,
  type SourceConnection,
  type UpdateSourceConnectionRequest,
} from '../contracts/source-plane/source-plane.schema';
import { decryptSecret, encryptSecret } from './credential-cipher';
import { CredentialProvider } from './oauth/credential-provider';
import { SourceOAuthService } from './oauth/source-oauth.service';
import type { Connector, ConnectorConnectionView, ConnectorRegistry } from './connector';
import {
  connectorState,
  connectorUnavailableMessage,
  findConnector,
  SOURCE_CONNECTORS,
} from './connector';
import { Inject } from '@nestjs/common';

/** Raw `source_connection` row (SurrealDB record id in `id`). */
export interface SourceConnectionRow {
  id: unknown;
  packId: string;
  sourceId: string;
  kind: string;
  connector: string;
  shape: SourceConnection['shape'];
  host: string;
  label?: string | null;
  config?: Record<string, unknown> | null;
  credential?: string | null;
  mode: SourceConnection['mode'];
  schedule: SourceConnection['schedule'];
  contentPolicy: SourceConnection['contentPolicy'];
  deletePolicy: SourceConnection['deletePolicy'];
  fetchBudget?: number | null;
  status: SourceConnection['status'];
  checkpoint?: Record<string, unknown> | null;
  vertical: string;
  recorder: string;
  sourceKey: string;
  lastSyncAt?: unknown;
  lastSyncStatus?: string | null;
  lastError?: string | null;
  /** Encrypted; set = the inbound webhook is on (W4.2c). */
  webhookSecret?: string | null;
  lastWebhookAt?: unknown;
  userId?: string | null;
  scope?: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

const VERTICAL = /^[a-z][a-z0-9_]{0,63}$/;
const LABEL_MAX = 120;

/**
 * SourceConnectionService — the connector–credential pair of an installed
 * source pack (raw-evidence-sources-2026-09.md § 5.2). Creating one is the
 * operator's explicit decision to READ one external system; the pack's
 * `sources` entry says what may be connected, the connection says what IS.
 *
 * Identity: every connection is a `source_registry` recorder
 * (`vertical:recorder`, sources.schema.ts), declared on create — the
 * nightly trust refit learns a per-connection agreement rate for free.
 *
 * Scope: `ownerUserId` makes the connection personal — every row it
 * produces is written `userId`-fenced (0055) with the matching 0093 tag;
 * absent = an org connection (G6 steps 3–5 carry its ACLs).
 *
 * Secrets: `credential` is encrypted at rest when SOURCE_CREDENTIAL_ENCRYPTION_KEY
 * is set (credential-cipher.ts; a legacy clear value stays readable and
 * is re-encrypted on its next write); an `oauth:<grant id>` value is a
 * POINTER to a connected account — not a secret, stored in the clear —
 * and the grant holds the encrypted tokens. Never serialised outward:
 * `toView` strips it. The engine reads it through CredentialProvider.
 */
@Injectable()
export class SourceConnectionService {
  private readonly logger = new Logger(SourceConnectionService.name);

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly sources: SourcesService,
    @Optional() @Inject(SOURCE_CONNECTORS) private readonly connectors?: ConnectorRegistry,
    @Optional() private readonly credentials?: CredentialProvider,
    @Optional() private readonly oauth?: SourceOAuthService,
  ) {}

  async create(companyId: string, dto: CreateSourceConnectionRequest): Promise<SourceConnection> {
    const { manifest, entry } = await this.resolveSourceEntry(companyId, dto.packId, dto.sourceId);
    if (!VERTICAL.test(dto.vertical)) {
      throw new BadRequestException(`vertical must match ${VERTICAL}`);
    }
    const connector = connectorKindOf(entry);
    await this.assertConnectable(entry, connector, dto);
    await this.assertCredential(companyId, {
      connector,
      host: dto.host ?? 'server',
      credential: dto.credential,
    });
    const userId = dto.ownerUserId ?? undefined;
    const content = {
      packId: manifest.id,
      sourceId: entry.id,
      kind: entry.kind,
      connector,
      shape: entry.shape,
      host: dto.host ?? 'server',
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      config: dto.config ?? {},
      ...(dto.credential !== undefined ? { credential: storedCredential(dto.credential) } : {}),
      mode: dto.mode ?? 'synced',
      schedule: dto.schedule ?? entry.defaults?.schedule ?? 'manual',
      contentPolicy: dto.contentPolicy ?? entry.defaults?.contentPolicy ?? 'text',
      deletePolicy: dto.deletePolicy ?? entry.defaults?.deletePolicy ?? 'close',
      ...(dto.fetchBudget !== undefined ? { fetchBudget: dto.fetchBudget } : {}),
      status: 'active',
      vertical: dto.vertical,
      // Filled after CREATE: the recorder is derived from the row id.
      recorder: 'pending',
      sourceKey: 'pending',
      ...(userId ? { userId } : {}),
      scope: scopeForUser(userId),
    };
    const row = await this.surreal.withCompany(companyId, async (db) => {
      const [created] = await queryRows<SourceConnectionRow>(
        db,
        `CREATE source_connection CONTENT $content`,
        { content },
      );
      if (!created) throw new Error('source_connection create returned no row');
      const tail = idTailOf(String(created.id));
      const recorder = `srcconn_${tail}`;
      const sourceKey = `${dto.vertical}:${recorder}`;
      const [updated] = await queryRows<SourceConnectionRow>(
        db,
        `UPDATE type::record('source_connection', $tail) SET recorder = $recorder, sourceKey = $sourceKey`,
        { tail, recorder, sourceKey },
      );
      return updated ?? { ...created, recorder, sourceKey };
    });
    // The registry identity: declared type from the source's kind, a
    // neutral authority, the pack as owner. Best-effort — a registry
    // hiccup must not orphan the connection.
    try {
      await this.sources.declare(companyId, row.sourceKey, {
        type: registryTypeOf(entry),
        authLevel: 0.5,
        owner: `pack:${manifest.id}`,
        note: `source connection ${idTailOf(String(row.id))} (${entry.id})`,
      });
    } catch (err) {
      this.logger.warn(
        `source_registry declare failed for ${row.sourceKey}: ${(err as Error).message}`,
      );
    }
    return toView(row);
  }

  /** Every connection row of the tenant, newest first (credential included — engine reads only). */
  async listRows(companyId: string): Promise<SourceConnectionRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      queryRows<SourceConnectionRow>(
        db,
        `SELECT * FROM source_connection ORDER BY createdAt DESC LIMIT 1000`,
      ),
    );
  }

  async list(companyId: string): Promise<SourceConnection[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<SourceConnectionRow>(
        db,
        `SELECT * FROM source_connection ORDER BY createdAt DESC LIMIT 500`,
      ),
    );
    return rows.map(toView);
  }

  async get(companyId: string, connectionId: string): Promise<SourceConnection> {
    return toView(await this.load(companyId, connectionId));
  }

  /** The raw row, credential included — the engine's read. */
  async load(companyId: string, connectionId: string): Promise<SourceConnectionRow> {
    const row = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<SourceConnectionRow>(
        db,
        `SELECT * FROM type::record('source_connection', $tail) LIMIT 1`,
        { tail: idTailOf(connectionId) },
      ),
    );
    if (!row) throw new NotFoundException('source connection not found');
    return row;
  }

  async update(
    companyId: string,
    connectionId: string,
    patch: UpdateSourceConnectionRequest,
  ): Promise<SourceConnection> {
    const current = await this.load(companyId, connectionId);
    if (patch.label !== undefined && patch.label !== null && patch.label.length > LABEL_MAX) {
      throw new BadRequestException(`label must be at most ${LABEL_MAX} characters`);
    }
    if (patch.credential !== undefined) {
      await this.assertCredential(companyId, {
        connector: current.connector,
        host: current.host,
        credential: patch.credential ?? undefined,
      });
    }
    const sets: string[] = [];
    const vars: Record<string, unknown> = { tail: idTailOf(connectionId) };
    const assign = (field: string, value: unknown) => {
      sets.push(`${field} = $${field}`);
      vars[field] = value;
    };
    if (patch.label !== undefined) {
      if (patch.label === null) sets.push('label = NONE');
      else assign('label', patch.label);
    }
    if (patch.config !== undefined) assign('config', patch.config);
    if (patch.credential !== undefined) {
      if (patch.credential === null) sets.push('credential = NONE');
      else assign('credential', storedCredential(patch.credential));
    }
    if (patch.schedule !== undefined) assign('schedule', patch.schedule);
    if (patch.contentPolicy !== undefined) assign('contentPolicy', patch.contentPolicy);
    if (patch.deletePolicy !== undefined) assign('deletePolicy', patch.deletePolicy);
    if (patch.fetchBudget !== undefined) {
      if (patch.fetchBudget === null) sets.push('fetchBudget = NONE');
      else assign('fetchBudget', patch.fetchBudget);
    }
    if (patch.status !== undefined) assign('status', patch.status);
    if (sets.length === 0) return this.get(companyId, connectionId);
    const row = await this.surreal.withCompany(companyId, async (db) => {
      const [updated] = await queryRows<SourceConnectionRow>(
        db,
        `UPDATE type::record('source_connection', $tail) SET ${sets.join(', ')}`,
        vars,
      );
      return updated;
    });
    if (!row) throw new NotFoundException('source connection not found');
    return toView(row);
  }

  /**
   * Delete the connection and its catalogue. The items are catalogue
   * rows only — the documents / assets / facts they produced stay (the
   * facts-survive philosophy of pack uninstall); `deletePolicy` governs
   * a source that DELETES an item, not an operator who disconnects a
   * source. SELECT-ids-then-DELETE (the 3.2.4 planner discipline).
   */
  async remove(companyId: string, connectionId: string): Promise<{ items: number }> {
    await this.load(companyId, connectionId);
    const tail = idTailOf(connectionId);
    return this.surreal.withCompany(companyId, async (db) => {
      await db.query(`UPDATE type::record('source_connection', $tail) SET status = 'deleting'`, {
        tail,
      });
      let items = 0;
      for (;;) {
        const ids = await queryRows<{ id: unknown }>(
          db,
          `SELECT id FROM source_item WHERE connectionId = type::record('source_connection', $tail) LIMIT 500`,
          { tail },
        );
        if (ids.length === 0) break;
        await db.query(`DELETE $ids`, { ids: ids.map((r) => r.id) });
        items += ids.length;
      }
      await db.query(`DELETE type::record('source_connection', $tail)`, { tail });
      return { items };
    });
  }

  /** The engine's bookkeeping after a run. */
  async recordSync(
    companyId: string,
    connectionId: string,
    p: {
      status: 'succeeded' | 'failed' | 'skipped';
      checkpoint?: Record<string, unknown> | null | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    const sets = ['lastSyncAt = time::now()', 'lastSyncStatus = $status'];
    const vars: Record<string, unknown> = { tail: idTailOf(connectionId), status: p.status };
    if (p.checkpoint !== undefined) {
      if (p.checkpoint === null) sets.push('checkpoint = NONE');
      else {
        sets.push('checkpoint = $checkpoint');
        vars.checkpoint = p.checkpoint;
      }
    }
    if (p.error !== undefined) {
      sets.push('lastError = $error');
      vars.error = p.error.slice(0, 500);
    } else {
      sets.push('lastError = NONE');
    }
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE type::record('source_connection', $tail) SET ${sets.join(', ')}`, vars),
    );
  }

  /** Active, schedule-bearing connections whose next run is due. */
  async due(companyId: string, now: Date): Promise<SourceConnectionRow[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<SourceConnectionRow>(
        db,
        `SELECT * FROM source_connection WHERE status = 'active' AND schedule != 'manual' AND host = 'server'`,
      ),
    );
    return rows.filter((r) => isDue(r, now));
  }

  /**
   * What the connected account says about itself beyond the token — the
   * API origin a provider names at its token endpoint (Salesforce
   * `instance_url`, Pipedrive `api_domain`): a connector runs against
   * it when the connection names no origin of its own. Null for a
   * secret credential or a grant without one.
   */
  async grantHints(
    companyId: string,
    row: SourceConnectionRow,
  ): Promise<ConnectorConnectionView['grant']> {
    if (!this.credentials) return null;
    return this.credentials.hints(companyId, row.credential);
  }

  /** The inbound webhook's secret (set = on), encrypted at rest like a credential; null switches it off. */
  async setWebhookSecret(
    companyId: string,
    connectionId: string,
    secret: string | null,
  ): Promise<void> {
    const tail = idTailOf(connectionId);
    await this.surreal.withCompany(companyId, (db) =>
      secret === null
        ? db.query(`UPDATE type::record('source_connection', $tail) SET webhookSecret = NONE`, {
            tail,
          })
        : db.query(`UPDATE type::record('source_connection', $tail) SET webhookSecret = $secret`, {
            tail,
            secret: encryptSecret(secret),
          }),
    );
  }

  /** The webhook secret in the clear — for verification only, never for a view. */
  webhookSecretOf(row: SourceConnectionRow): string | null {
    if (typeof row.webhookSecret !== 'string' || row.webhookSecret.length === 0) return null;
    return decryptSecret(row.webhookSecret);
  }

  /** An accepted webhook call — the operator's "is the vendor reaching us?". */
  async touchWebhook(companyId: string, connectionId: string): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE type::record('source_connection', $tail) SET lastWebhookAt = time::now()`, {
        tail: idTailOf(connectionId),
      }),
    );
  }

  /** The platform connector that runs this connection, if installed and on. */
  resolveConnector(row: SourceConnectionRow): Connector | null {
    return findConnector(this.connectors ?? [], row.connector);
  }

  /** The operator-facing reason resolveConnector() returned null. */
  connectorUnavailable(row: SourceConnectionRow): string {
    const state = connectorState(this.connectors ?? [], row.connector);
    return typeof state === 'string'
      ? connectorUnavailableMessage(row.connector, state)
      : `connector "${row.connector}" is available`;
  }

  /**
   * What must hold before a connection row exists: a server-run entry
   * (native, http MCP) needs its connector installed and on; an http MCP
   * entry needs its server named exactly once (pinned by the pack or
   * `config.url`, guarded); the label fits.
   */
  private async assertConnectable(
    entry: PackSourceSpec,
    connector: string,
    dto: CreateSourceConnectionRequest,
  ): Promise<void> {
    const host = dto.host ?? 'server';
    if (host !== 'server' && !AGENT_HOST.test(host)) {
      throw new BadRequestException('host must be "server" or "agent:<id>"');
    }
    // An agent-host connection runs its connector on the agent: the
    // server needs no installed connector for it, only the bookkeeping.
    const serverRun =
      host === 'server' &&
      (entry.kind === 'native' || (entry.kind === 'mcp' && entry.transport === 'http'));
    if (serverRun) {
      const state = connectorState(this.connectors ?? [], connector);
      if (typeof state === 'string') {
        throw new BadRequestException(
          `source "${entry.id}": ${connectorUnavailableMessage(connector, state)}`,
        );
      }
    }
    if (host === 'server' && entry.kind === 'mcp' && entry.transport === 'http') {
      await assertOperatorUrl(entry, dto.config ?? {});
    }
    if (dto.label !== undefined && dto.label.length > LABEL_MAX) {
      throw new BadRequestException(`label must be at most ${LABEL_MAX} characters`);
    }
  }

  /**
   * The pack entry a row instantiates plus the pack's install secret —
   * what an `mcp` connection needs at run time (the declared url / auth,
   * the bearer for `install_secret`). Null entry = the pack is gone or
   * no longer declares the source; the connector says so by name.
   */
  async sourceContext(
    companyId: string,
    row: SourceConnectionRow,
  ): Promise<{ source: PackSourceSpec | null; installSecret: string | null }> {
    const builtin = BUILTIN_PACKS.find((p) => p.id === row.packId);
    if (builtin) {
      return {
        source: builtin.sources?.find((s) => s.id === row.sourceId) ?? null,
        installSecret: null,
      };
    }
    const pack = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<{ manifest?: DomainPackManifest; webhookSecret?: unknown }>(
        db,
        `SELECT manifest, webhookSecret FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId: row.packId },
      ),
    );
    return {
      source: pack?.manifest?.sources?.find((s) => s.id === row.sourceId) ?? null,
      installSecret: typeof pack?.webhookSecret === 'string' ? pack.webhookSecret : null,
    };
  }

  /**
   * The secret the connector runs with — through CredentialProvider: a
   * connected account's fresh access token, an operator secret
   * decrypted, a legacy clear value as-is. Throws by name when a grant
   * is revoked / broken or a key is missing; the caller records it as
   * the run's failure.
   */
  async credentialFor(companyId: string, row: SourceConnectionRow): Promise<string | null> {
    if (!this.credentials) return row.credential ?? null;
    return this.credentials.resolve(companyId, row.credential);
  }

  /**
   * A connector that speaks through a connected account needs one on a
   * server-host connection — `oauth:<grant id>` naming an ACTIVE grant
   * of the connector's provider in this tenant. Any other connector
   * refuses an `oauth:` value: a grant is not a bearer for a URL.
   */
  private async assertCredential(
    companyId: string,
    p: { connector: string; host: string; credential: string | undefined },
  ): Promise<void> {
    const { connector, host, credential } = p;
    const spec = findConnector(this.connectors ?? [], connector);
    const grantId = grantIdOfCredential(credential);
    if (credential?.startsWith('oauth:') && !grantId) {
      throw new BadRequestException('credential: "oauth:" must name a grant id');
    }
    if (!spec?.oauth) {
      if (grantId) {
        throw new BadRequestException(
          `connector "${connector}" takes a secret, not a connected account`,
        );
      }
      return;
    }
    if (host !== 'server') return;
    // A vendor that also takes its own token (Pipedrive's API token) may run on it.
    if (!grantId && spec.oauth.optional && credential) return;
    if (!grantId) {
      throw new BadRequestException(
        `connector "${connector}" runs as a connected ${spec.oauth.provider} account — connect one first and pass credential "oauth:<grant id>"`,
      );
    }
    if (!this.oauth) return;
    const grant = await this.oauth.get(companyId, grantId).catch(() => null);
    if (!grant) throw new BadRequestException(`no connected account ${grantId} in this tenant`);
    if (grant.provider !== spec.oauth.provider) {
      throw new BadRequestException(
        `connected account ${grantId} is a ${grant.provider} account; "${connector}" needs ${spec.oauth.provider}`,
      );
    }
    if (grant.status !== 'active') {
      throw new BadRequestException(
        `connected account ${grantId} is ${grant.status} — reconnect it`,
      );
    }
  }

  /** The connector-facing projection of a row (credential resolved). */
  toConnectorView(
    row: SourceConnectionRow,
    context: {
      source: PackSourceSpec | null;
      installSecret: string | null;
      /** From `credentialFor` — the row's stored value is never handed over raw. */
      credential?: string | null | undefined;
      /** From `grantHints` — what the connected account said about itself. */
      grant?: ConnectorConnectionView['grant'];
    } = { source: null, installSecret: null },
  ): ConnectorConnectionView {
    const source = context.source;
    // An `install_secret` MCP source authenticates with the pack's own
    // secret unless the connection carries a credential of its own.
    const installBearer =
      source?.kind === 'mcp' && source.transport === 'http' && source.auth === 'install_secret'
        ? context.installSecret
        : null;
    return {
      id: String(row.id),
      packId: row.packId,
      sourceId: row.sourceId,
      kind: row.kind,
      connector: row.connector,
      shape: row.shape,
      host: row.host,
      config: row.config ?? {},
      credential: context.credential ?? installBearer,
      credentialSource: context.credential
        ? grantIdOfCredential(row.credential)
          ? 'grant'
          : 'secret'
        : installBearer
          ? 'install'
          : null,
      contentPolicy: row.contentPolicy,
      deletePolicy: row.deletePolicy,
      vertical: row.vertical,
      recorder: row.recorder,
      userId: row.userId ?? null,
      source,
      grant: context.grant ?? null,
    };
  }

  /**
   * The pack's `sources` entry this connection instantiates: from the
   * tenant's installed row (consented — the checksum must match the
   * installed section, else the operator re-accepts first) or from a
   * builtin pack (globally seeded, no install row, no consent needed).
   */
  private async resolveSourceEntry(
    companyId: string,
    packId: string,
    sourceId: string,
  ): Promise<{ manifest: DomainPackManifest; entry: PackSourceSpec }> {
    const builtin = BUILTIN_PACKS.find((p) => p.id === packId);
    let manifest: DomainPackManifest | undefined = builtin;
    if (!manifest) {
      const row = await this.surreal.withCompany(companyId, (db) =>
        queryFirst<{
          manifest?: DomainPackManifest;
          acceptedSources?: unknown;
          acceptedSourcesChecksum?: unknown;
        }>(
          db,
          `SELECT manifest, acceptedSources, acceptedSourcesChecksum FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
          { packId },
        ),
      );
      if (!row?.manifest) throw new NotFoundException(`pack "${packId}" is not installed`);
      manifest = row.manifest;
      const checksum = sourcesChecksum(manifest);
      if (
        checksum &&
        (row.acceptedSources !== true || String(row.acceptedSourcesChecksum ?? '') !== checksum)
      ) {
        throw new BadRequestException(
          `pack "${packId}" declares sources that were not accepted at install — reinstall with acceptSources: true`,
        );
      }
    }
    const entry = (manifest.sources ?? []).find((s) => s.id === sourceId);
    if (!entry) {
      throw new NotFoundException(`pack "${packId}" declares no source "${sourceId}"`);
    }
    return { manifest, entry };
  }
}

/** Which Connector.kind runs a pack's source entry. */
export function connectorKindOf(entry: PackSourceSpec): string {
  if (entry.kind === 'native') return entry.connector;
  return entry.kind; // 'mcp' | 'external'
}

function registryTypeOf(entry: PackSourceSpec): SourceType {
  if (entry.kind === 'native') return entry.connector === 'url' ? 'website' : 'document';
  return 'api';
}

const SCHEDULE_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

export function isDue(row: SourceConnectionRow, now: Date): boolean {
  const every = SCHEDULE_MS[row.schedule];
  if (every === undefined) return false;
  const last = toDate(row.lastSyncAt);
  if (!last) return true;
  return now.getTime() - last.getTime() >= every;
}

/**
 * SurrealDB datetimes reach the SDK as Date, ISO string or epoch number
 * — and, under jest's vm realm, as a Date from ANOTHER realm that fails
 * `instanceof`; `new Date(value)` accepts all of them.
 */
function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'object') {
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toIso(v: unknown): string | null {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

/** The wire projection — never the credential. */
export function toView(row: SourceConnectionRow): SourceConnection {
  return {
    id: String(row.id),
    packId: row.packId,
    sourceId: row.sourceId,
    kind: row.kind as SourceConnection['kind'],
    connector: row.connector,
    shape: row.shape,
    host: row.host,
    label: row.label ?? null,
    config: row.config ?? {},
    hasCredential: typeof row.credential === 'string' && row.credential.length > 0,
    grantId: grantIdOfCredential(row.credential),
    mode: row.mode,
    schedule: row.schedule,
    contentPolicy: row.contentPolicy,
    deletePolicy: row.deletePolicy,
    fetchBudget: row.fetchBudget ?? null,
    status: row.status,
    checkpoint: row.checkpoint ?? null,
    vertical: row.vertical,
    recorder: row.recorder,
    sourceKey: row.sourceKey,
    ownerUserId: row.userId ?? null,
    lastSyncAt: toIso(row.lastSyncAt),
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastError: row.lastError ?? null,
    webhook: {
      enabled: typeof row.webhookSecret === 'string' && row.webhookSecret.length > 0,
      lastEventAt: toIso(row.lastWebhookAt),
    },
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Bound-var-safe record link (the candidate-store idiom). */
export function connectionRef(connectionId: string): unknown {
  return new StringRecordId(`source_connection:${idTailOf(connectionId)}`);
}

/**
 * An http MCP entry without a pinned url is operator-named: the
 * connection must carry `config.url`, and it passes the egress guard at
 * create (the install-time guard covered pinned urls only). With a
 * pinned url, a `config.url` is refused — the consented server is the
 * one the pack named. Private hosts follow the double opt-in.
 */
async function assertOperatorUrl(
  entry: PackMcpHttpSourceSpec,
  config: Record<string, unknown>,
): Promise<void> {
  const named = config.url;
  if (entry.url !== undefined) {
    if (named !== undefined) {
      throw new BadRequestException(
        `source "${entry.id}" pins its server (${entry.url}); config.url is not accepted`,
      );
    }
    return;
  }
  if (typeof named !== 'string' || named.length === 0) {
    throw new BadRequestException(`source "${entry.id}" needs config.url — the MCP server to read`);
  }
  const allowHttp = config.allowPrivate === true && sourceEgressAllowPrivate();
  try {
    await assertPublicHttpUrl(named, { allowHttp });
  } catch (e) {
    if (e instanceof EgressDeniedError) throw new BadRequestException(`config.url: ${e.message}`);
    throw e;
  }
}

/** What the column holds: a grant pointer in the clear, anything else encrypted (when a key is set). */
function storedCredential(credential: string): string {
  return grantIdOfCredential(credential) ? credential : encryptSecret(credential);
}
