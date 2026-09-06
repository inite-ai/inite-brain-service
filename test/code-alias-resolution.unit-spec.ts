/**
 * INGEST_CODE_ALIAS_RESOLUTION — deterministic alias-aware entity
 * resolution for code identifiers (the code-memory battery's k10 identity
 * class): a module mentioned by FILE PATH and by the SYMBOL it defines
 * must resolve to ONE entity.
 *
 * Two layers under test:
 *  1. the pure derivation (src/ingest/code-alias.ts) — conservative,
 *     exact-normalized, deterministic;
 *  2. the resolution-reuse path in EntityUpsertService — flag ON reuses
 *     the existing entity instead of creating a twin (both directions,
 *     scope-fenced, ambiguity-safe); flag OFF is byte-identical to
 *     today's create-a-twin behavior (pinned).
 */
import {
  isCodeSymbolShaped,
  pathNeedlesForSymbol,
  symbolAliasForPath,
} from '../src/ingest/code-alias';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';

const FLAG = 'INGEST_CODE_ALIAS_RESOLUTION';

describe('code-alias derivation (pure, deterministic)', () => {
  it('derives the PascalCase symbol from a kebab-case path', () => {
    expect(symbolAliasForPath('src/gateway/webhook-dispatcher.ts')).toBe('WebhookDispatcher');
    expect(symbolAliasForPath('webhook-dispatcher.ts')).toBe('WebhookDispatcher');
  });

  it('derives from snake_case and NestJS dotted basenames', () => {
    expect(symbolAliasForPath('workers/webhook_dispatcher.py')).toBe('WebhookDispatcher');
    expect(symbolAliasForPath('src/ingest/entity-upsert.service.ts')).toBe('EntityUpsertService');
  });

  it('README.md and other non-code files derive NOTHING', () => {
    expect(symbolAliasForPath('README.md')).toBeNull(); // docs, not a module
    expect(symbolAliasForPath('README.ts')).toBeNull(); // all-caps convention file
    expect(symbolAliasForPath('docker-compose.staging.yml')).toBeNull(); // data file
    expect(symbolAliasForPath('notes.txt')).toBeNull();
  });

  it('is conservative: no extension, generic or single-hump basenames, spaces', () => {
    expect(symbolAliasForPath('src/gateway')).toBeNull(); // no extension
    expect(symbolAliasForPath('index.ts')).toBeNull(); // every dir has one
    expect(symbolAliasForPath('dispatcher.ts')).toBeNull(); // single capitalized word
    expect(symbolAliasForPath('webhook dispatcher.ts')).toBeNull(); // not a path
    expect(symbolAliasForPath('')).toBeNull();
  });

  it('recognizes PascalCase code symbols only (>= 2 humps, has lowercase)', () => {
    expect(isCodeSymbolShaped('WebhookDispatcher')).toBe(true);
    expect(isCodeSymbolShaped('BgeM3')).toBe(true);
    expect(isCodeSymbolShaped('Readme')).toBe(false); // one hump = a plain word
    expect(isCodeSymbolShaped('Priya')).toBe(false);
    expect(isCodeSymbolShaped('webhookDispatcher')).toBe(false); // camelCase
    expect(isCodeSymbolShaped('WEBHOOK')).toBe(false); // no lowercase
    expect(isCodeSymbolShaped('Webhook Dispatcher')).toBe(false);
  });

  it('maps a symbol to its conventional basename needles', () => {
    expect(pathNeedlesForSymbol('WebhookDispatcher')).toEqual([
      'webhook-dispatcher',
      'webhook_dispatcher',
      'webhookdispatcher',
    ]);
    expect(pathNeedlesForSymbol('Readme')).toEqual([]);
    expect(pathNeedlesForSymbol('not a symbol')).toEqual([]);
  });

  it('round-trips: derived symbol verifies back against its source path', () => {
    const symbol = symbolAliasForPath('src/gateway/webhook-dispatcher.ts');
    expect(symbol).not.toBeNull();
    expect(pathNeedlesForSymbol(symbol!).some((n) => 'webhook-dispatcher'.includes(n))).toBe(true);
  });
});

// ── resolution-reuse path ───────────────────────────────────────────

/** Route db.query by SQL substring; unmatched queries return no rows. */
function fakeDb(routes: Array<{ needle: string; rows: Array<Record<string, unknown>> }>): {
  query: jest.Mock;
} {
  const query = jest.fn((sql: string, _vars?: Record<string, unknown>) => {
    const hit = routes.find((r) => sql.includes(r.needle));
    return Promise.resolve([hit ? hit.rows : []]);
  });
  return { query };
}

const STEP2 = 'canonicalNameLc = $name'; // exact canonical/alias match
const FORWARD = 'canonicalNameLc = $sym'; // path → symbol lookup
const REVERSE = 'string::contains'; // symbol → path candidate scan
const STAMP = 'array::union'; // alias append
const CREATE = 'CREATE type::table'; // dbCreate

const PATH = 'src/gateway/webhook-dispatcher.ts';
const SYMBOL = 'WebhookDispatcher';

function resolve(svc: EntityUpsertService, db: { query: jest.Mock }, name: string) {
  return svc.resolveOrCreateNamedEntity({
    db: db as never,
    e: { name, type: 'asset' },
    hint: undefined,
    _contextRef: { vertical: 'work' },
  });
}

const sqlCalls = (db: { query: jest.Mock }): string[] =>
  db.query.mock.calls.map((c: unknown[]) => String(c[0]));

describe('EntityUpsertService code-alias resolution (flag ON)', () => {
  const saved = process.env[FLAG];
  beforeEach(() => {
    process.env[FLAG] = '1';
    delete process.env.INGEST_CONFUSABLES_CHECK;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it('a path mention reuses the existing symbol entity — no twin created', async () => {
    const db = fakeDb([
      { needle: FORWARD, rows: [{ id: 'knowledge_entity:sym1' }] },
      { needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] },
    ]);
    const out = await resolve(new EntityUpsertService(), db, PATH);
    expect(out).toBe('knowledge_entity:sym1');
    expect(sqlCalls(db).some((s) => s.includes(CREATE))).toBe(false); // twin NOT created
    // The path surface is stamped onto the reused entity's aliases.
    const stamp = db.query.mock.calls.find((c: unknown[]) => String(c[0]).includes(STAMP));
    expect(stamp).toBeDefined();
    expect((stamp![1] as { add: string[] }).add).toEqual([PATH]);
  });

  it('a symbol mention reuses the existing path entity (reverse, verified)', async () => {
    const db = fakeDb([
      { needle: REVERSE, rows: [{ id: 'knowledge_entity:p1', canonicalName: PATH }] },
      { needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] },
    ]);
    const out = await resolve(new EntityUpsertService(), db, SYMBOL);
    expect(out).toBe('knowledge_entity:p1');
    expect(sqlCalls(db).some((s) => s.includes(CREATE))).toBe(false);
    const stamp = db.query.mock.calls.find((c: unknown[]) => String(c[0]).includes(STAMP));
    expect((stamp![1] as { add: string[] }).add).toEqual([SYMBOL]);
  });

  it('both alias lookups stay tenant-global and skip merged-away entities', async () => {
    const db = fakeDb([{ needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] }]);
    const svc = new EntityUpsertService();
    await resolve(svc, db, PATH);
    await resolve(svc, db, SYMBOL);
    const aliasQueries = sqlCalls(db).filter((s) => s.includes(FORWARD) || s.includes(REVERSE));
    expect(aliasQueries.length).toBeGreaterThan(0);
    for (const sql of aliasQueries) {
      expect(sql).toContain('userId IS NONE'); // personal entities never match
      expect(sql).toContain('mergedInto IS NONE');
    }
  });

  it('an AMBIGUOUS match (two candidates) creates new instead of guessing', async () => {
    const db = fakeDb([
      {
        needle: FORWARD,
        rows: [{ id: 'knowledge_entity:sym1' }, { id: 'knowledge_entity:sym2' }],
      },
      { needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] },
    ]);
    const out = await resolve(new EntityUpsertService(), db, PATH);
    expect(out).toBe('knowledge_entity:new1');
    expect(sqlCalls(db).some((s) => s.includes(STAMP))).toBe(false);
  });

  it('README.md never alias-merges — even when an unrelated "Readme" entity exists', async () => {
    const db = fakeDb([
      // If the forward lookup ever ran, it WOULD find this "Readme" entity.
      { needle: FORWARD, rows: [{ id: 'knowledge_entity:readme_person' }] },
      { needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] },
    ]);
    const out = await resolve(new EntityUpsertService(), db, 'README.md');
    expect(out).toBe('knowledge_entity:new1'); // fresh entity, no merge
    expect(sqlCalls(db).some((s) => s.includes(FORWARD) || s.includes(REVERSE))).toBe(false);
  });

  it('a plain capitalized word ("Readme") never triggers the reverse scan', async () => {
    const db = fakeDb([{ needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] }]);
    await resolve(new EntityUpsertService(), db, 'Readme');
    expect(sqlCalls(db).some((s) => s.includes(REVERSE))).toBe(false);
  });

  it('a freshly-minted path entity is born with its derived symbol alias', async () => {
    const db = fakeDb([{ needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] }]);
    await resolve(new EntityUpsertService(), db, PATH);
    const create = db.query.mock.calls.find((c: unknown[]) => String(c[0]).includes(CREATE));
    expect((create![1] as { d: { aliases: string[] } }).d.aliases).toEqual([PATH, SYMBOL]);
  });

  it('an alias-lookup failure falls through to create-new (never blocks ingest)', async () => {
    const db = {
      query: jest.fn((sql: string) => {
        if (sql.includes(FORWARD)) return Promise.reject(new Error('surreal down'));
        if (sql.includes(CREATE)) return Promise.resolve([[{ id: 'knowledge_entity:new1' }]]);
        return Promise.resolve([[]]);
      }),
    };
    const out = await resolve(new EntityUpsertService(), db, PATH);
    expect(out).toBe('knowledge_entity:new1');
  });
});

describe('EntityUpsertService with the flag OFF (pinned: byte-identical today-behavior)', () => {
  const saved = process.env[FLAG];
  beforeEach(() => {
    delete process.env[FLAG];
    delete process.env.INGEST_CONFUSABLES_CHECK;
  });
  afterAll(() => {
    if (saved !== undefined) process.env[FLAG] = saved;
  });

  it('a path mention creates the twin exactly as today', async () => {
    const db = fakeDb([
      // The symbol entity EXISTS — but with the flag off it must not be found.
      { needle: FORWARD, rows: [{ id: 'knowledge_entity:sym1' }] },
      { needle: CREATE, rows: [{ id: 'knowledge_entity:new1' }] },
    ]);
    const out = await resolve(new EntityUpsertService(), db, PATH);
    expect(out).toBe('knowledge_entity:new1'); // the twin forms, as before
    // Exactly two queries: the step-2 canonical match and the CREATE —
    // no alias lookup, no stamp, nothing extra computed.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(sqlCalls(db)[0]).toContain(STEP2);
    expect(sqlCalls(db)[1]).toContain(CREATE);
    const create = db.query.mock.calls[1]!;
    expect((create[1] as { d: { aliases: string[] } }).d.aliases).toEqual([PATH]); // no symbol seeded
  });
});
