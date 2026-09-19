/**
 * The agent's `db` connector on a real SQLite file (W4.4): tables and
 * views become record envelopes, a change column makes the walk
 * incremental with the maximum seen as the checkpoint, a table without
 * one is hashed row by row, the session is read-only at the database,
 * every identifier is validated before it is ever quoted, and the DSN
 * is the agent's — a connection only names the database.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DbAgentConnector,
  configOf,
  envelopeOf,
  isoOf,
} from '../clients/brain-agent/src/connectors/db';
import {
  dialectOf,
  openSession,
  quoteIdent,
} from '../clients/brain-agent/src/connectors/db-session';
import { databaseEnvName, databaseNames, resolveDsn } from '../clients/brain-agent/src/config';
import type { AgentConnection, ConnectorCtx, ItemDelta } from '../clients/brain-agent/src/types';

let dir = '';
let dsn = '';

const CONFIG = {
  database: 'crm',
  entities: [
    {
      type: 'deal',
      table: 'deals',
      nameColumn: 'title',
      updatedAtColumn: 'updated_at',
      relations: [{ kind: 'organization', column: 'company_id', targetType: 'organization' }],
    },
    { type: 'organization', table: 'companies_v', columns: ['industry'] },
  ],
};

function ctxOf(config: Record<string, unknown>, log: string[] = []): ConnectorCtx {
  const connection: AgentConnection = {
    id: 'source_connection:db1',
    packId: 'crm_memory',
    sourceId: 'db',
    kind: 'native',
    connector: 'db',
    shape: 'structure',
    host: 'agent:laptop',
    label: null,
    config,
    contentPolicy: 'text',
    schedule: 'manual',
    status: 'active',
  };
  return {
    connection,
    source: null,
    signal: new AbortController().signal,
    log: (l) => log.push(l),
  };
}

async function collect(it: AsyncIterable<ItemDelta>): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of it) out.push(d);
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-agent-db-'));
  const file = join(dir, 'crm.sqlite');
  dsn = `sqlite:${file}`;
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry TEXT, secret TEXT);
    CREATE VIEW companies_v AS SELECT id, name, industry FROM companies;
    CREATE TABLE deals (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount REAL, stage TEXT,
      company_id INTEGER, blob BLOB, updated_at TEXT NOT NULL
    );
    INSERT INTO companies VALUES (5, 'Nimbus Foods', 'Food', 'do-not-read');
    INSERT INTO companies VALUES (6, 'Acme Robotics', 'Robotics', 'do-not-read');
    INSERT INTO deals VALUES (100, 'Nimbus — Q4 supply', 48000, 'Negotiation', 5, X'00ff', '2026-09-01T10:00:00Z');
    INSERT INTO deals VALUES (101, 'Acme — robots', 125000, 'Proposal', 6, NULL, '2026-09-03T12:30:00Z');
  `);
  db.close();
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('db session', () => {
  it('names a dialect by scheme, quotes identifiers per dialect, and opens SQLite read-only', async () => {
    expect(dialectOf('postgres://ro@db/crm')).toBe('postgres');
    expect(dialectOf('postgresql://ro@db/crm')).toBe('postgres');
    expect(dialectOf('mysql://ro@db/crm')).toBe('mysql');
    expect(dialectOf('mariadb://ro@db/crm')).toBe('mysql');
    expect(dialectOf('sqlite:/tmp/x.db')).toBe('sqlite');
    expect(dialectOf('/tmp/x.db')).toBe('sqlite');
    expect(() => dialectOf('mongodb://x')).toThrow(/unsupported database scheme "mongodb"/);
    expect(quoteIdent('postgres', 'crm.deals')).toBe('"crm"."deals"');
    expect(quoteIdent('mysql', 'deals')).toBe('`deals`');
    expect(quoteIdent('sqlite', 'a"b')).toBe('"a""b"');
    const s = await openSession(dsn);
    expect(s.dialect).toBe('sqlite');
    expect(await s.query('SELECT count(*) AS n FROM deals WHERE id > ?', [100])).toEqual([
      { n: 1 },
    ]);
    await expect(s.query("INSERT INTO companies (id, name) VALUES (9, 'x')", [])).rejects.toThrow(
      /readonly|read-only/i,
    );
    await s.close();
  });

  it('the DSN is resolved by name from the environment first, then the config — the brain never sees it', () => {
    const env = { BRAIN_AGENT_DB_CRM: 'postgres://env@x/crm' } as NodeJS.ProcessEnv;
    expect(databaseEnvName('crm-prod')).toBe('BRAIN_AGENT_DB_CRM_PROD');
    expect(resolveDsn('crm', { databases: { crm: 'sqlite:/file.db' } }, env)).toBe(
      'postgres://env@x/crm',
    );
    expect(
      resolveDsn('crm', { databases: { crm: 'sqlite:/file.db' } }, {} as NodeJS.ProcessEnv),
    ).toBe('sqlite:/file.db');
    expect(resolveDsn('other', { databases: {} }, env)).toBeNull();
    expect(databaseNames({ databases: { erp: 'x' } }, env)).toEqual(['crm', 'erp']);
  });
});

describe('db connector', () => {
  it('validates the config before any SQL: identifiers only, a database name, at least one entity', () => {
    expect(() => configOf(ctxOf({ database: 'crm', entities: [] }))).toThrow(/at least one table/);
    expect(() =>
      configOf(ctxOf({ database: 'postgres://x', entities: [{ type: 'a', table: 'b' }] })),
    ).toThrow(/config\.database/);
    expect(() =>
      configOf(
        ctxOf({ database: 'crm', entities: [{ type: 'deal', table: 'deals; drop table x' }] }),
      ),
    ).toThrow(/table ".*" is not an identifier/);
    expect(() =>
      configOf(
        ctxOf({
          database: 'crm',
          entities: [{ type: 'deal', table: 'deals', idColumn: 'id) --' }],
        }),
      ),
    ).toThrow(/column/);
    expect(() =>
      configOf(
        ctxOf({
          database: 'crm',
          entities: [
            {
              type: 'deal',
              table: 'deals',
              relations: [{ kind: 'x y', column: 'c', targetType: 't' }],
            },
          ],
        }),
      ),
    ).toThrow(/relation/);
    expect(
      configOf(
        ctxOf({
          database: 'crm',
          entities: [{ type: 'deal', table: 'crm.deals' }],
          pageSize: 50000,
        }),
      ).pageSize,
    ).toBe(10_000);
  });

  it('a first walk: every row of every entity as an upsert with a revision, the checkpoint at the maximum change stamp; fetch builds the envelope', async () => {
    const log: string[] = [];
    const ctx = ctxOf(CONFIG, log);
    const connector = new DbAgentConnector((name) => (name === 'crm' ? dsn : null));
    expect(connector.fullWalk(ctx)).toBe(false);
    const deltas = await collect(connector.enumerate(ctx, { checkpoint: null, full: false }));
    const ups = deltas.filter((d) => d.type === 'upsert') as Array<
      Extract<ItemDelta, { type: 'upsert' }>
    >;
    expect(ups.map((u) => u.item.externalId)).toEqual([
      'deal/100',
      'deal/101',
      'organization/5',
      'organization/6',
    ]);
    expect(ups[0]!.item).toMatchObject({
      title: 'Nimbus — Q4 supply',
      revision: '2026-09-01T10:00:00.000Z',
      modifiedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(ups[2]!.item.revision).toMatch(/^h:[0-9a-f]{20}$/);
    const cp = deltas.find((d) => d.type === 'checkpoint') as Extract<
      ItemDelta,
      { type: 'checkpoint' }
    >;
    expect(cp.checkpoint).toEqual({ since: { deal: '2026-09-03T12:30:00Z' } });

    const deal = await connector.fetch(ctx, ups[0]!.item);
    expect(deal).toEqual({
      shape: 'structure',
      record: {
        entityType: 'deal',
        externalId: '100',
        name: 'Nimbus — Q4 supply',
        attributes: { amount: 48000, stage: 'Negotiation' },
        relations: [
          {
            kind: 'organization',
            targetType: 'organization',
            targetExternalId: '5',
            targetName: 'Nimbus Foods',
          },
        ],
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
    });
    // The view's `columns` pick industry only: the base table's secret column is never read.
    const org = await connector.fetch(ctx, ups[2]!.item);
    expect(org).toEqual({
      shape: 'structure',
      record: {
        entityType: 'organization',
        externalId: '5',
        name: 'Nimbus Foods',
        attributes: { industry: 'Food' },
      },
    });
    // A fetch the walk did not cover reads one row by key — and its relation target's name the same way.
    await connector.endRun(ctx);
    const again = await connector.fetch(ctx, { externalId: 'organization/6' });
    expect(again.shape === 'structure' && again.record.name).toBe('Acme Robotics');
    const cold = await connector.fetch(ctx, { externalId: 'deal/101' });
    expect(cold.shape === 'structure' && cold.record.relations).toEqual([
      {
        kind: 'organization',
        targetType: 'organization',
        targetExternalId: '6',
        targetName: 'Acme Robotics',
      },
    ]);
    await expect(connector.fetch(ctx, { externalId: 'organization/7' })).rejects.toThrow(
      /no such row/,
    );
    await connector.endRun(ctx);
    expect(log.some((l) => /deal: 2 row\(s\)/.test(l))).toBe(true);
  });

  it('an incremental walk reads only what changed after the checkpoint; a full one reads everything; a table without a change column is always whole', async () => {
    const db = new DatabaseSync(dsn.slice('sqlite:'.length));
    db.exec(`
      UPDATE deals SET stage = 'Contract', updated_at = '2026-09-10T08:00:00Z' WHERE id = 100;
      INSERT INTO deals VALUES (102, 'Nimbus — renewal', 9000, 'Lead', 5, NULL, '2026-09-11T09:00:00Z');
    `);
    db.close();
    const connector = new DbAgentConnector(() => dsn);
    const ctx = ctxOf(CONFIG);
    const checkpoint = { since: { deal: '2026-09-03T12:30:00Z' } };
    const inc = await collect(connector.enumerate(ctx, { checkpoint, full: false }));
    const ids = (kind: ItemDelta[]) =>
      kind
        .filter((d) => d.type === 'upsert')
        .map((d) => (d as Extract<ItemDelta, { type: 'upsert' }>).item.externalId);
    expect(ids(inc)).toEqual(['deal/100', 'deal/102', 'organization/5', 'organization/6']);
    const cp = inc.find((d) => d.type === 'checkpoint') as Extract<
      ItemDelta,
      { type: 'checkpoint' }
    >;
    expect(cp.checkpoint).toEqual({ since: { deal: '2026-09-11T09:00:00Z' } });
    await connector.endRun(ctx);
    const full = await collect(connector.enumerate(ctx, { checkpoint, full: true }));
    expect(ids(full)).toEqual([
      'deal/100',
      'deal/101',
      'deal/102',
      'organization/5',
      'organization/6',
    ]);
    await connector.endRun(ctx);
    // No change column anywhere: the connector asks for a full walk itself.
    const whole = new DbAgentConnector(() => dsn);
    expect(
      whole.fullWalk(
        ctxOf({ database: 'crm', entities: [{ type: 'organization', table: 'companies_v' }] }),
      ),
    ).toBe(true);
  });

  it('an unknown database name fails by name and names the two ways to set it; pages are read by key', async () => {
    const connector = new DbAgentConnector(() => null);
    await expect(
      collect(connector.enumerate(ctxOf(CONFIG), { checkpoint: null, full: false })),
    ).rejects.toThrow(
      /knows no database "crm" — brain-agent db add crm <dsn>, or set BRAIN_AGENT_DB_CRM/,
    );
    const paged = new DbAgentConnector(() => dsn);
    const ctx = ctxOf({ ...CONFIG, pageSize: 1 });
    const deltas = await collect(paged.enumerate(ctx, { checkpoint: null, full: true }));
    expect(deltas.filter((d) => d.type === 'upsert')).toHaveLength(5);
    await paged.endRun(ctx);
  });

  it('envelopes: scalars pass, dates become ISO, binary is left out, JSON objects are stringified; change stamps parse from SQL text, epochs and Dates', () => {
    const rec = envelopeOf(
      { type: 'x', table: 't', updatedAtColumn: 'u' },
      {
        id: 7n,
        name: null,
        u: new Date('2026-01-02T03:04:05Z'),
        n: 1.5,
        b: true,
        big: 2n ** 60n,
        bin: new Uint8Array([1]),
        j: { a: 1 },
        nothing: null,
      },
    );
    expect(rec).toEqual({
      entityType: 'x',
      externalId: '7',
      name: '7',
      attributes: { n: 1.5, b: true, big: (2n ** 60n).toString(), j: '{"a":1}', nothing: null },
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(isoOf('2026-09-01 10:00:00')).toBe('2026-09-01T10:00:00.000Z');
    expect(isoOf('2026-09-01T10:00:00+02:00')).toBe('2026-09-01T08:00:00.000Z');
    expect(isoOf(1_756_720_000)).toBe('2025-09-01T09:46:40.000Z');
    expect(isoOf(1_756_720_000_000)).toBe('2025-09-01T09:46:40.000Z');
    expect(isoOf('not a date')).toBeNull();
    expect(isoOf(null)).toBeNull();
  });
});
