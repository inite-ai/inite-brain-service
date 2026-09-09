import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMBEDDER_PROVIDER_NAMES,
  EMBEDDING_SPACES,
  EMBEDDING_TABLES,
  NON_EMBEDDING_FLOAT_COLUMNS,
  VECTOR_COLUMNS,
  declaredSpace,
  providerIdOf,
} from '../src/ai/embedder/embedding-space';
import { widthGateClause } from '../src/db/vector-width';

/**
 * Embedding-space truth gate.
 *
 * The defect this exists to make unrepresentable: the vector width was
 * restated in five places that could disagree — the two provider
 * constructors, two env defaults, the HNSW `DIMENSION` DDL, and the
 * commented-out DDL in the migrations. Nothing tied them together, so a
 * 1536-wide vector could be written into a 1024-wide corpus, where
 * SurrealDB accepts it silently and then fails every cosine query over
 * that table.
 *
 * Catching that at runtime is the weaker half. These gates derive the
 * truth from the source — the same idiom as
 * `config-catalog-truth.unit-spec.ts` — so the NEXT embedding provider or
 * the next vector table cannot be added without declaring its space.
 */
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const EMBEDDER_DIR = join(SRC, 'ai', 'embedder');
const DB_DIR = join(SRC, 'db');

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const TS_FILES = walk(SRC, '.ts');
const SURQL_FILES = walk(DB_DIR, '.surql');
const key = (c: { table: string; field: string }) => `${c.table}.${c.field}`;

/** Prose explaining a rule must not trip the rule. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** `DEFINE FIELD <f> ON [TABLE] <t> TYPE [option<]array<float>` — whitespace
 *  collapsed first so multi-line definitions parse. */
function declaredFloatColumns(): Set<string> {
  const pattern =
    /DEFINE\s+FIELD\s+(?:IF\s+NOT\s+EXISTS\s+|OVERWRITE\s+)?(\w+)\s+ON\s+(?:TABLE\s+)?(\w+)\s+TYPE\s+(?:option<)?array<float>/gi;
  // A later migration may retire a column (`REMOVE FIELD [IF EXISTS] f ON
  // [TABLE] t`); the schema a tenant runs is the fold of the files in
  // order, so a removal after the last definition takes the column out.
  const removal = /REMOVE\s+FIELD\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ON\s+(?:TABLE\s+)?(\w+)/gi;
  const found = new Set<string>();
  for (const f of [...SURQL_FILES].sort()) {
    const text = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
    for (const m of text.matchAll(pattern)) found.add(`${m[2]}.${m[1]}`);
    for (const m of text.matchAll(removal)) found.delete(`${m[2]}.${m[1]}`);
  }
  return found;
}

describe('embedding-space truth — the schema cannot hold an unclassified vector', () => {
  it('every array<float> column in the migrations is classified', () => {
    const declared = new Set<string>([
      ...VECTOR_COLUMNS.map(key),
      ...NON_EMBEDDING_FLOAT_COLUMNS.map(key),
    ]);
    const unclassified = [...declaredFloatColumns()].filter((c) => !declared.has(c)).sort();
    // A new vector column must be added to VECTOR_COLUMNS (it lives in an
    // embedding space and is width-bound) or to NON_EMBEDDING_FLOAT_COLUMNS
    // (a calibration curve — width-agnostic, never cosine-compared).
    expect(unclassified).toEqual([]);
  });

  it('every classified column actually exists in the migrations', () => {
    const inSchema = declaredFloatColumns();
    const declared = [...VECTOR_COLUMNS.map(key), ...NON_EMBEDDING_FLOAT_COLUMNS.map(key)];
    expect(declared.filter((c) => !inSchema.has(c)).sort()).toEqual([]);
  });

  it('the reindex sweep only sweeps columns the schema declares', () => {
    const vectors = new Set(VECTOR_COLUMNS.map(key));
    const swept = EMBEDDING_TABLES.flatMap((t) =>
      t.vectorFields.map((f) => `${t.table}.${f}`),
    ).sort();
    expect(swept.filter((c) => !vectors.has(c))).toEqual([]);
  });
});

describe('embedding-space truth — every cosine scan carries the width gate', () => {
  // vector::similarity::cosine over one foreign-width row aborts the WHOLE
  // statement (SurrealDB 3.2.4). Every scan in src/ must skip such rows with
  // `array::len(col) = array::len($q)` in the same statement (see
  // src/db/vector-width.ts); this is what keeps the next scan site honest.
  const COSINE = /vector::similarity::cosine\(\s*([A-Za-z_.]+)\s*,\s*\$([A-Za-z_]+)\s*\)/g;

  it('in application code: each statement with a cosine has the gate for that column', () => {
    const offenders: string[] = [];
    for (const f of TS_FILES) {
      const text = stripComments(readFileSync(f, 'utf8'));
      // One template literal is one statement (or one shared filter string).
      for (const lit of text.match(/`[^`]*`/gs) ?? []) {
        for (const m of lit.matchAll(COSINE)) {
          const [, field, param] = m as unknown as [string, string, string];
          if (!lit.includes(widthGateClause(field, param))) {
            offenders.push(`${f.slice(ROOT.length + 1)}: cosine(${field}, $${param}) without gate`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('in the store: the latest fn::resolve_fact revision gates its dedup cosine', () => {
    // The dedup gate inside resolve_fact is copied into every revision; only
    // the highest-numbered file is what a tenant runs.
    const defining = SURQL_FILES.filter((f) =>
      /DEFINE FUNCTION (OVERWRITE |IF NOT EXISTS )?fn::resolve_fact\(/.test(
        readFileSync(f, 'utf8'),
      ),
    ).sort();
    const latest = defining[defining.length - 1]!;
    const body = readFileSync(latest, 'utf8');
    expect(body).toMatch(/array::len\(embedding\) = array::len\(\$embedding\)/);
    expect(body).toMatch(/vector::similarity::cosine\(embedding, \$embedding\)/);
  });
});

describe('embedding-space truth — the width is never restated', () => {
  it('no HNSW DIMENSION literal exists anywhere; every one is interpolated', () => {
    // A hardcoded DIMENSION is exactly how the DDL width and the code
    // width drift apart. In .ts it must be `${...}`; in .surql (the
    // commented-out reference DDL) it must not name a number at all.
    const offenders: string[] = [];
    for (const f of [...TS_FILES, ...SURQL_FILES]) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/HNSW\s+DIMENSION\s+(\S+)/gi)) {
        if (/^\d+$/.test(m[1]!)) offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the HNSW DDL width comes from the primary embedder, not the active one', () => {
    const svc = stripComments(
      readFileSync(join(SRC, 'admin', 'hnsw-maintenance.service.ts'), 'utf8'),
    );
    expect(svc).toMatch(/primaryDimensions\(\)/);
    // The ACTIVE provider is the fallback during warmup; baking its width
    // into DDL builds an index the primary can never write to.
    expect(svc).not.toMatch(/getDimensions\(\)/);
  });

  it('no env var can set an embedding model or width', () => {
    // Width is a property of the model. An operator "configuring" one can
    // only desynchronise the store from what the model emits.
    const banned =
      /(OPENAI_EMBEDDING_DIMENSIONS|OPENAI_EMBEDDING_MODEL|BGE_M3_DIMENSIONS|BGE_M3_MODEL_ID)/;
    const offenders = TS_FILES.filter((f) => {
      const text = readFileSync(f, 'utf8');
      // Prose in a comment explaining the removal is fine; a read is not.
      return banned.test(stripComments(text));
    }).map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe('embedding-space truth — every provider declares its space', () => {
  const providerFiles = readdirSync(EMBEDDER_DIR).filter((f) => f.endsWith('.provider.ts'));

  it('there is exactly one declared space per shipped provider', () => {
    expect(providerFiles.length).toBe(EMBEDDER_PROVIDER_NAMES.length);
  });

  it.each(providerFiles)('%s derives its identity from the declaration', (file) => {
    const text = readFileSync(join(EMBEDDER_DIR, file), 'utf8');
    // Takes the declared space rather than a loose model/dimensions pair…
    expect(text).toMatch(/space:\s*EmbeddingSpaceConfig/);
    // …and derives providerId from it rather than spelling a vendor prefix.
    expect(text).toMatch(/providerIdOf\(cfg\.space\)/);
    expect(text).not.toMatch(/providerId\s*=\s*`[a-z0-9-]+:/i);
  });

  it('each declared space produces a well-formed, unique provider id', () => {
    const ids = EMBEDDER_PROVIDER_NAMES.map((n) => providerIdOf(declaredSpace(n)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of EMBEDDER_PROVIDER_NAMES) {
      const space = declaredSpace(name);
      expect(providerIdOf(space)).toBe(`${space.provider}:${space.model}:${space.dim}`);
      expect(Number.isInteger(space.dim)).toBe(true);
      expect(space.dim).toBeGreaterThanOrEqual(8);
    }
  });

  it('the selectable provider names are exactly the declared spaces', () => {
    expect([...EMBEDDER_PROVIDER_NAMES].sort()).toEqual(Object.keys(EMBEDDING_SPACES).sort());
  });
});
