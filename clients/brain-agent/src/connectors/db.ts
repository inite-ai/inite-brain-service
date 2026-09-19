import { createHash } from 'node:crypto';
import type {
  AgentConnector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../types.js';
import { openSession, quoteIdent, type DbSession, type Dialect, type Row } from './db-session.js';

/**
 * `db` — a database on THIS machine (or reachable from it) read as
 * records (docs/roadmap/crm-sources-2026-09.md W4.4): each configured
 * table or view is one entity type, each row one record envelope —
 * `{ entityType, externalId, name, attributes, relations, updatedAt }`
 * — and the brain's records door turns it into facts by the
 * connection's mapping. A self-hosted CRM, an ERP, a ticketing backend
 * read where its data lives.
 *
 * The DSN never leaves the machine: the connection names the database
 * (`config.database`, a label), the agent keeps the DSN for that label
 * in its own config (`brain-agent db add <name> <dsn>`) or reads
 * `BRAIN_AGENT_DB_<NAME>`. The session is read-only at the database;
 * every identifier comes from the config and is validated, quoted and
 * never interpolated from data; no SQL is ever taken from the brain.
 *
 * Walks: a table with an `updatedAtColumn` is read incrementally
 * (`updatedAt > since`, the maximum seen becomes the checkpoint) and
 * its deletions surface on a full walk; a table without one is walked
 * whole every run, its row hash the revision — so a connection whose
 * tables all lack one is a full walk by nature and the brain sweeps
 * what it did not see.
 */
export interface DbEntitySpec {
  /** The record type the rows become (`deal`, `person`, `organization`, …). */
  type: string;
  /** `table` or `schema.table` — a table or a view. */
  table: string;
  idColumn?: string;
  nameColumn?: string;
  updatedAtColumn?: string;
  /** The columns to read (default: every column). */
  columns?: string[];
  /** A foreign-key column read as a relation to another entity type. */
  relations?: Array<{ kind: string; column: string; targetType: string }>;
}

export interface DbSourceConfig {
  database: string;
  entities: DbEntitySpec[];
  /** Rows per query (default 1000). */
  pageSize?: number;
  /** A ceiling on rows read per entity per run (default 200 000). */
  maxRows?: number;
}

/** What the agent knows a database as: the DSN for a name, or nothing. */
export type DsnResolver = (name: string) => string | null;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const DEFAULT_PAGE = 1000;
const DEFAULT_MAX_ROWS = 200_000;

interface RunState {
  session: DbSession;
  rows: Map<string, { entity: DbEntitySpec; row: Row }>;
  /** `<type>/<id>` → the target's name, for relations whose target the walk did not cover. */
  names: Map<string, string | null>;
}

export class DbAgentConnector implements AgentConnector {
  readonly kind = 'db';
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly resolveDsn: DsnResolver,
    private readonly open: (dsn: string) => Promise<DbSession> = openSession,
  ) {}

  /** No table has a change column: every run is a full walk and the brain sweeps the unseen. */
  fullWalk(ctx: ConnectorCtx): boolean {
    return configOf(ctx).entities.every((e) => !e.updatedAtColumn);
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const session = await this.session(ctx, cfg);
    const state = this.runs.get(ctx.connection.id)!;
    const since = (opts.checkpoint?.since ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...since };
    const page = cfg.pageSize ?? DEFAULT_PAGE;
    const maxRows = cfg.maxRows ?? DEFAULT_MAX_ROWS;
    for (const entity of cfg.entities) {
      const q = queryFor(session.dialect, entity, page);
      const incremental = !opts.full && entity.updatedAtColumn !== undefined && since[entity.type] !== undefined;
      let lastId: unknown = null;
      let count = 0;
      let maxUpdated: unknown = since[entity.type];
      for (;;) {
        const params: unknown[] = [];
        let where = '';
        if (lastId !== null) {
          where += ` WHERE ${q.id} > ?`;
          params.push(lastId);
        }
        if (incremental) {
          where += `${where ? ' AND' : ' WHERE'} ${q.updatedAt} > ?`;
          params.push(sinceParam(session.dialect, since[entity.type]));
        }
        params.push(page);
        const rows = await session.query(`${q.select}${where} ORDER BY ${q.id} ASC LIMIT ?`, params);
        if (ctx.signal.aborted) throw new Error('aborted');
        for (const row of rows) {
          const id = row[q.idKey];
          if (id === null || id === undefined) continue;
          lastId = id;
          count++;
          const updated = entity.updatedAtColumn ? row[entity.updatedAtColumn] : undefined;
          if (updated !== undefined && updated !== null && later(updated, maxUpdated)) maxUpdated = updated;
          const externalId = `${entity.type}/${String(id)}`;
          state.rows.set(externalId, { entity, row });
          yield {
            type: 'upsert',
            item: {
              externalId,
              title: String(row[entity.nameColumn ?? 'name'] ?? id),
              revision: updated !== undefined && updated !== null ? revisionOf(updated) : rowHash(row),
              ...(isoOf(updated) ? { modifiedAt: isoOf(updated)! } : {}),
            },
          };
        }
        if (rows.length < page || count >= maxRows) break;
      }
      if (count >= maxRows) ctx.log(`${entity.type}: stopped at maxRows=${maxRows}`);
      if (entity.updatedAtColumn && maxUpdated !== undefined && maxUpdated !== null) {
        next[entity.type] = jsonSafe(maxUpdated);
      }
      ctx.log(`${entity.type}: ${count} row(s)${incremental ? ' since the checkpoint' : ''}`);
    }
    yield { type: 'checkpoint', checkpoint: { since: next } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const state = this.runs.get(ctx.connection.id);
    let found = state?.rows.get(item.externalId);
    if (!found) {
      // Not in this run's walk (a re-fetch the brain asked for by id): one row by key.
      const [type, ...rest] = item.externalId.split('/');
      const entity = cfg.entities.find((e) => e.type === type);
      if (!entity) throw new Error(`no entity "${type}" in the config`);
      const session = await this.session(ctx, cfg);
      const q = queryFor(session.dialect, entity, 1);
      const rows = await session.query(`${q.select} WHERE ${q.id} = ? LIMIT 1`, [rest.join('/')]);
      if (rows.length === 0) throw new Error(`${item.externalId}: no such row`);
      found = { entity, row: rows[0]! };
    }
    const record = envelopeOf(found.entity, found.row);
    // A foreign key names only an id; the door wants the target's name
    // too (it files the target as an entity of its own) — from this
    // run's walk, else one read by key from the target's table.
    for (const rel of record.relations ?? []) {
      const name = await this.targetName(ctx, cfg, rel.targetType, rel.targetExternalId);
      if (name) rel.targetName = name;
    }
    return { shape: 'structure', record };
  }

  private async targetName(
    ctx: ConnectorCtx,
    cfg: DbSourceConfig,
    targetType: string,
    id: string,
  ): Promise<string | null> {
    const target = cfg.entities.find((e) => e.type === targetType);
    if (!target) return null;
    const key = `${targetType}/${id}`;
    const state = this.runs.get(ctx.connection.id);
    const walked = state?.rows.get(key);
    if (walked) {
      const v = walked.row[target.nameColumn ?? 'name'];
      return v === null || v === undefined ? null : String(v);
    }
    const cached = state?.names.get(key);
    if (cached !== undefined) return cached;
    const session = await this.session(ctx, cfg);
    const dialect = session.dialect;
    const rows = await session.query(
      `SELECT ${quoteIdent(dialect, target.nameColumn ?? 'name')} AS n FROM ${quoteIdent(dialect, target.table)} WHERE ${quoteIdent(dialect, target.idColumn ?? 'id')} = ? LIMIT 1`,
      [id],
    );
    const v = rows[0]?.n;
    const name = v === null || v === undefined ? null : String(v);
    this.runs.get(ctx.connection.id)?.names.set(key, name);
    return name;
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    const state = this.runs.get(ctx.connection.id);
    this.runs.delete(ctx.connection.id);
    await state?.session.close();
  }

  private async session(ctx: ConnectorCtx, cfg: DbSourceConfig): Promise<DbSession> {
    const existing = this.runs.get(ctx.connection.id);
    if (existing) return existing.session;
    const dsn = this.resolveDsn(cfg.database);
    if (!dsn) {
      throw new Error(
        `this agent knows no database "${cfg.database}" — brain-agent db add ${cfg.database} <dsn>, or set BRAIN_AGENT_DB_${envName(cfg.database)}`,
      );
    }
    const session = await this.open(dsn);
    this.runs.set(ctx.connection.id, { session, rows: new Map(), names: new Map() });
    return session;
  }
}

/** The config as the connector reads it — every identifier validated, so nothing from it is ever unquoted SQL. */
export function configOf(ctx: ConnectorCtx): DbSourceConfig {
  const c = ctx.connection.config as Partial<DbSourceConfig>;
  if (typeof c.database !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(c.database)) {
    throw new Error('db: config.database names the database this agent holds the DSN for');
  }
  if (!Array.isArray(c.entities) || c.entities.length === 0) {
    throw new Error('db: config.entities lists at least one table or view');
  }
  for (const e of c.entities) {
    if (!IDENT.test(e.type)) throw new Error(`db: entity type "${e.type}" is not an identifier`);
    if (!TABLE.test(e.table)) throw new Error(`db: table "${e.table}" is not an identifier`);
    for (const col of [e.idColumn, e.nameColumn, e.updatedAtColumn, ...(e.columns ?? []), ...(e.relations ?? []).map((r) => r.column)]) {
      if (col !== undefined && !IDENT.test(col)) throw new Error(`db: column "${col}" is not an identifier`);
    }
    for (const r of e.relations ?? []) {
      if (!IDENT.test(r.kind) || !IDENT.test(r.targetType))
        throw new Error(`db: relation "${r.kind}" → "${r.targetType}" is not an identifier pair`);
    }
  }
  return {
    database: c.database,
    entities: c.entities,
    ...(typeof c.pageSize === 'number' && c.pageSize > 0 ? { pageSize: Math.min(Math.floor(c.pageSize), 10_000) } : {}),
    ...(typeof c.maxRows === 'number' && c.maxRows > 0 ? { maxRows: Math.floor(c.maxRows) } : {}),
  };
}

export function envName(database: string): string {
  return database.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function queryFor(dialect: Dialect, e: DbEntitySpec, _page: number) {
  const idKey = e.idColumn ?? 'id';
  const wanted = e.columns
    ? [...new Set([idKey, e.nameColumn ?? 'name', e.updatedAtColumn, ...e.columns, ...(e.relations ?? []).map((r) => r.column)].filter((x): x is string => typeof x === 'string'))]
    : null;
  const cols = wanted ? wanted.map((c) => quoteIdent(dialect, c)).join(', ') : '*';
  return {
    idKey,
    id: quoteIdent(dialect, idKey),
    updatedAt: e.updatedAtColumn ? quoteIdent(dialect, e.updatedAtColumn) : '',
    select: `SELECT ${cols} FROM ${quoteIdent(dialect, e.table)}`,
  };
}

/** The row as a record envelope: the id and name columns by name, relations by column, the rest as attributes. */
export function envelopeOf(e: DbEntitySpec, row: Row): Extract<FetchedItem, { shape: 'structure' }>['record'] {
  const idKey = e.idColumn ?? 'id';
  const nameKey = e.nameColumn ?? 'name';
  const relationCols = new Set((e.relations ?? []).map((r) => r.column));
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === idKey || k === nameKey || k === e.updatedAtColumn || relationCols.has(k)) continue;
    const s = scalarOf(v);
    if (s !== undefined) attributes[k] = s;
  }
  const relations = (e.relations ?? []).flatMap((r) => {
    const v = row[r.column];
    if (v === null || v === undefined || v === '') return [];
    return [{ kind: r.kind, targetType: r.targetType, targetExternalId: String(v) }];
  });
  const updatedAt = e.updatedAtColumn ? isoOf(row[e.updatedAtColumn]) : null;
  return {
    entityType: e.type,
    externalId: String(row[idKey]),
    name: String(row[nameKey] ?? row[idKey]),
    attributes,
    ...(relations.length > 0 ? { relations } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** A column value as the envelope carries it; binary and unknown objects are left out. */
function scalarOf(v: unknown): string | number | boolean | null | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (v instanceof Uint8Array) return undefined;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** An ISO timestamp out of a datetime column: a Date, an ISO / SQL string, epoch seconds or milliseconds. */
export function isoOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v.includes('T') || /[+-]\d\d:?\d\d$|Z$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function revisionOf(updated: unknown): string {
  return isoOf(updated) ?? String(updated);
}

function rowHash(row: Row): string {
  const canonical = JSON.stringify(Object.keys(row).sort().map((k) => [k, jsonSafe(row[k])]));
  return `h:${createHash('sha1').update(canonical).digest('hex').slice(0, 20)}`;
}

/** Later by time when both parse as one, else by the driver's own value. */
function later(a: unknown, b: unknown): boolean {
  if (b === undefined || b === null) return true;
  const ta = isoOf(a);
  const tb = isoOf(b);
  if (ta && tb) return ta > tb;
  return String(a) > String(b);
}

function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return undefined;
  return v;
}

/**
 * The checkpoint value as the dialect compares it: a Date for the
 * drivers that bind one, SQL text for MySQL, the stored form for SQLite
 * (whose datetime is whatever was written — text or epoch).
 */
function sinceParam(dialect: Dialect, since: unknown): unknown {
  const iso = isoOf(since);
  if (!iso) return since;
  if (dialect === 'postgres') return iso;
  if (dialect === 'mysql') return iso.replace('T', ' ').replace('Z', '');
  return since;
}
