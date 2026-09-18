import { createHash } from 'node:crypto';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
  RecordEnvelope,
} from '../connector';
import type { OAuthProviderId } from '../oauth/oauth-providers';
import { mergeMappings, type EntityMapping, type RecordMapping } from './record-mapping';

/**
 * The records contract (docs/roadmap/crm-sources-2026-09.md § 4.2): one
 * direction, a connector per vendor. A CRM connector extends
 * `RecordsConnector` and implements only what is the vendor's — its
 * entity types and their fields, `list` with its own paging and its own
 * spelling of "updated since", `get` for one record, a preset mapping of
 * fields to the pack vocabulary — and inherits the rest: per-entity
 * checkpoints with an overlap window, one catalogue item per record
 * (`<type>/<id>`, the record's `updatedAt` as revision), the run-local
 * cache that makes `fetch` free, relation targets named from records
 * seen in the same run, and the same `structure` door as every other
 * vendor.
 */

export interface EntityFieldSpec {
  key: string;
  label: string;
}

/** What a vendor can list — static, so the catalogue and the connect form know it without a run. */
export interface EntitySpec {
  type: string;
  label: string;
  /** Selected when the connection names no `entities`. */
  defaultOn: boolean;
  fields: EntityFieldSpec[];
}

export interface ListCursor {
  /** ISO 8601 lower bound on updated-at, already widened by the overlap; null = everything. */
  since: string | null;
  /** The vendor's own page token from the previous call; null = the first page. */
  page: unknown;
}

export interface ListPage {
  records: RecordEnvelope[];
  /** The vendor's token for the next page; null = done. */
  next: unknown;
}

export interface RecordsConnectionConfig {
  /** Entity types to sync; absent = the ones the connector marks `defaultOn`. */
  entities?: string[] | undefined;
  /** The connection's own mapping, merged over the connector's preset. */
  mapping?: RecordMapping | undefined;
  /** Minutes the incremental window is widened by (default 10). */
  overlapMinutes?: number | undefined;
  /** Records per entity per run (default 50 000). */
  maxRecords?: number | undefined;
}

const DEFAULT_OVERLAP_MINUTES = 10;
const DEFAULT_MAX_RECORDS = 50_000;
/** Extra `get` calls a run may spend naming relation targets it did not list. */
const TARGET_LOOKUP_CAP = 200;

interface RunState {
  records: Map<string, RecordEnvelope>;
  names: Map<string, string>;
  lookups: number;
}

export abstract class RecordsConnector implements Connector {
  abstract readonly kind: string;
  abstract readonly entities: EntitySpec[];
  /** Field → predicate defaults, per entity type — the vendor's knowledge of its own schema. */
  abstract readonly preset: RecordMapping;
  readonly oauth?: { provider: OAuthProviderId; scopes: string[]; optional?: boolean };
  readonly credentialHint?: string;
  readonly configExample?: Record<string, unknown>;

  private readonly runs = new Map<string, RunState>();

  /** One page of one entity type, changed since `cursor.since` when set. */
  abstract list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage>;
  /** One record by its vendor id; null when gone. Optional — without it, unseen relation targets stay unnamed. */
  get?(ctx: ConnectorCtx, entity: string, externalId: string): Promise<RecordEnvelope | null>;

  enabled?(): boolean;

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const state = this.stateOf(ctx);
    const selected = this.selectedEntities(cfg);
    const previous = checkpointEntities(opts.checkpoint);
    const runStart = new Date();
    const overlapMs = (cfg.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES) * 60_000;
    const maxRecords = cfg.maxRecords ?? DEFAULT_MAX_RECORDS;
    const next: Record<string, { since: string }> = {};
    for (const entity of selected) {
      const sinceStored = opts.full ? null : (previous[entity.type]?.since ?? null);
      const since = sinceStored
        ? new Date(new Date(sinceStored).getTime() - overlapMs).toISOString()
        : null;
      let page: unknown = null;
      let count = 0;
      do {
        if (ctx.signal.aborted) throw new Error('aborted');
        const got = await this.list(ctx, entity.type, { since, page });
        for (const record of got.records) {
          const externalId = itemIdOf(entity.type, record.externalId);
          state.records.set(externalId, record);
          state.names.set(externalId, record.name);
          count++;
          yield { type: 'upsert', item: describeRecord(entity.type, record) };
          if (count >= maxRecords) break;
        }
        page = count < maxRecords ? got.next : null;
      } while (page !== null && page !== undefined);
      next[entity.type] = { since: runStart.toISOString() };
      ctx.log(`${this.kind}: ${entity.type} — ${count} record(s)${since ? ` since ${since}` : ''}`);
    }
    yield { type: 'checkpoint', checkpoint: { walkedAt: runStart.toISOString(), entities: next } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const state = this.stateOf(ctx);
    const { type, id } = parseItemId(item.externalId);
    let record = state.records.get(item.externalId) ?? null;
    if (!record) {
      if (!this.get) throw new Error(`${this.kind}: ${item.externalId} was not listed in this run`);
      record = await this.get(ctx, type, id);
      if (!record) throw new Error(`${this.kind}: ${item.externalId} is gone at the source`);
    }
    const named = await this.nameTargets(ctx, state, record);
    const mapping = mergeMappings(this.preset, cfg.mapping)[type];
    return { shape: 'structure', record: named, ...(mapping ? { mapping } : {}) };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    this.runs.delete(ctx.connection.id);
  }

  /** The entity specs a connection syncs. */
  selectedEntities(cfg: RecordsConnectionConfig): EntitySpec[] {
    const wanted = cfg.entities;
    return this.entities.filter((e) => (wanted ? wanted.includes(e.type) : e.defaultOn));
  }

  /** The mapping in force for a connection: the preset under its own. */
  mappingFor(cfg: RecordsConnectionConfig): RecordMapping {
    return mergeMappings(this.preset, cfg.mapping);
  }

  /** A record with its relation targets named — what `fetch` hands the door; the preview uses it too. */
  async named(ctx: ConnectorCtx, record: RecordEnvelope): Promise<RecordEnvelope> {
    const state = this.stateOf(ctx);
    state.names.set(itemIdOf(record.entityType, record.externalId), record.name);
    return this.nameTargets(ctx, state, record);
  }

  /** Relation targets get their names from records seen this run, else one bounded `get` each. */
  private async nameTargets(
    ctx: ConnectorCtx,
    state: RunState,
    record: RecordEnvelope,
  ): Promise<RecordEnvelope> {
    if (!record.relations?.length) return record;
    const relations = [];
    for (const rel of record.relations) {
      if (rel.targetName) {
        relations.push(rel);
        continue;
      }
      const key = itemIdOf(rel.targetType, rel.targetExternalId);
      let name = state.names.get(key);
      if (!name && this.get && state.lookups < TARGET_LOOKUP_CAP) {
        state.lookups++;
        const target = await this.get(ctx, rel.targetType, rel.targetExternalId).catch(() => null);
        if (target) {
          name = target.name;
          state.names.set(key, name);
        }
      }
      relations.push(name ? { ...rel, targetName: name } : rel);
    }
    return { ...record, relations };
  }

  private stateOf(ctx: ConnectorCtx): RunState {
    let s = this.runs.get(ctx.connection.id);
    if (!s) {
      s = { records: new Map(), names: new Map(), lookups: 0 };
      this.runs.set(ctx.connection.id, s);
    }
    return s;
  }
}

/** `<type>/<vendor id>` — the catalogue identity of a record. */
export function itemIdOf(type: string, externalId: string): string {
  return `${type}/${externalId}`;
}

export function parseItemId(itemId: string): { type: string; id: string } {
  const i = itemId.indexOf('/');
  if (i === -1) return { type: '', id: itemId };
  return { type: itemId.slice(0, i), id: itemId.slice(i + 1) };
}

/** The catalogue row for a record: revision = its updated-at, else a hash of its content. */
export function describeRecord(type: string, r: RecordEnvelope): ItemDescriptor {
  const revision = r.updatedAt
    ? `at:${r.updatedAt}`
    : `hash:${createHash('sha256')
        .update(JSON.stringify([r.attributes, r.relations ?? []]))
        .digest('hex')
        .slice(0, 16)}`;
  return {
    externalId: itemIdOf(type, r.externalId),
    title: r.name,
    path: `${type}/${r.name}`,
    mediaType: 'application/json',
    revision,
    ...(r.updatedAt ? { modifiedAt: r.updatedAt } : {}),
  };
}

export function configOf(ctx: ConnectorCtx): RecordsConnectionConfig {
  return ctx.connection.config as RecordsConnectionConfig;
}

function checkpointEntities(
  checkpoint: Record<string, unknown> | null,
): Record<string, { since?: string }> {
  const raw = checkpoint?.entities;
  return raw && typeof raw === 'object' ? (raw as Record<string, { since?: string }>) : {};
}

/** Exposed for the form: which mapping a connection ends up with. */
export type { EntityMapping };
