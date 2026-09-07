/**
 * Fragment-bearing processor outputs + representation embeddings —
 * unit coverage of the two seams this PR fixes, over a scripted Surreal
 * double and the REAL EvidenceStoreService (the write shape is the thing
 * under test, so stubbing the seam would test nothing).
 *
 * THE BREAK. Processor runs wrote every derived_representation with
 * `subjectKind: 'asset'`, while the only serving lane
 * (FragmentLaneService) filters `subjectKind = 'fragment'` — so a
 * perfect OCR adapter produced rows retrieval could never return. And
 * `derived_representation.embedding` had no producer at all, so the
 * lane's dense leg was empty by construction.
 *
 * Pins here:
 *   - locator-less output stays asset-level, byte-identical (the row
 *     written is key-for-key what it was before this PR);
 *   - locator-bearing output creates the fragment FIRST and attaches the
 *     representation to it (subjectKind 'fragment');
 *   - the fragment is deduped by LOCATOR identity: the same span twice
 *     in one run, and a re-run under a bumped processor version, reuse
 *     the one deterministic record id;
 *   - EVIDENCE_FRAGMENT_EMBEDDINGS off ⇒ the embedder is never touched
 *     (pinned with a throwing stub) and neither vector key is written;
 *     on ⇒ vector + embeddingSpaceId land; an embed failure is soft (the
 *     row is written, the run still succeeds);
 *   - the per-run embed budget caps fan-out.
 */
import { StringRecordId } from 'surrealdb';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { ProcessingRunService } from '../src/evidence/processing/processing-run.service';
import type {
  ProcessorAdapter,
  ProcessorOutput,
} from '../src/evidence/processing/processor-adapter';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EvidenceStorageRegistry } from '../src/evidence/storage/storage-adapter';

const COMPANY = 'co_proc_unit';
const ASSET = 'evidence_asset:a1';

interface Call {
  sql: string;
  params: Record<string, unknown> | undefined;
}

/**
 * Scripted Surreal double: routes by query text, records every call and
 * every CREATE payload. `insertedFragments` tracks deterministic ids so a
 * second INSERT IGNORE over the same id reports the collision (empty
 * result) exactly as SurrealDB would.
 */
function surrealOf(opts: { assetPiiClasses?: string[] | undefined } = {}) {
  const calls: Call[] = [];
  const creates: Array<{ table: string; content: Record<string, unknown> }> = [];
  const insertedFragmentIds = new Set<string>();
  let seq = 0;
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT IGNORE INTO processing_run')) return [[{ id: 'processing_run:r' }]];
      if (sql.includes('INSERT IGNORE INTO evidence_fragment')) {
        const row = (params?.row ?? {}) as { id: unknown };
        const id = String(row.id);
        if (insertedFragmentIds.has(id)) return [[]];
        insertedFragmentIds.add(id);
        return [[{ id }]];
      }
      if (sql.includes("type::record('evidence_asset'")) {
        return [
          [
            {
              id: ASSET,
              modality: 'document',
              availability: 'hot',
              ...(opts.assetPiiClasses !== undefined ? { piiClasses: opts.assetPiiClasses } : {}),
            },
          ],
        ];
      }
      if (sql.includes("type::record('evidence_fragment'")) {
        return [[{ id: `evidence_fragment:${String(params?.tail)}`, availability: 'hot' }]];
      }
      if (sql.includes('CREATE type::table($t) CONTENT $d')) {
        const table = String(params?.t);
        const content = (params?.d ?? {}) as Record<string, unknown>;
        creates.push({ table, content });
        seq += 1;
        return [[{ ...content, id: `${table}:c${seq}` }]];
      }
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_companyId: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  return { surreal, calls, creates, insertedFragmentIds };
}

const adapterOf = (outputs: ProcessorOutput[], version = 'proc-v1'): ProcessorAdapter => ({
  capability: 'text',
  version,
  configParts: () => [],
  accepts: () => true,
  process: () => Promise.resolve(outputs),
});

const embedderThrowing = {
  embed: () => {
    throw new Error('the embedder must not be called');
  },
  activeSpaceId: () => {
    throw new Error('the embedder must not be called');
  },
} as unknown as EmbedderService;

const embedderOk = {
  embed: async (text: string) => [text.length, 0.5],
  activeSpaceId: () => 'openai:text-embedding-3-small:1536:l2',
} as unknown as EmbedderService;

const embedderBroken = {
  embed: async () => {
    throw new Error('model 503');
  },
  activeSpaceId: () => 'openai:text-embedding-3-small:1536:l2',
} as unknown as EmbedderService;

function runnerOf(
  surreal: SurrealService,
  embedder: EmbedderService | undefined,
): ProcessingRunService {
  const registry = new Map() as unknown as EvidenceStorageRegistry;
  const store = new EvidenceStoreService(surreal, registry, embedder);
  return new ProcessingRunService(surreal, store, registry);
}

const CHAR_SPAN = { kind: 'charRange', start: 0, end: 11 } as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['EVIDENCE_SUBSTRATE_ENABLED', 'EVIDENCE_FRAGMENT_EMBEDDINGS']) {
    savedEnv[k] = process.env[k];
  }
  process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
  delete process.env.EVIDENCE_FRAGMENT_EMBEDDINGS;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  delete process.env.EVIDENCE_FRAGMENT_EMBEDDINGS;
});

const execute = (runs: ProcessingRunService, adapter: ProcessorAdapter) =>
  runs.execute(COMPANY, {
    assetRecordId: ASSET,
    packId: 'pack_a',
    adapter,
    input: { asset: {} as never, openStream: null },
  });

describe('processor outputs — locator-less rows stay asset-level (byte-identity pin)', () => {
  it('writes exactly the pre-PR row and never touches evidence_fragment', async () => {
    const { surreal, calls, creates } = surrealOf();
    const runs = runnerOf(surreal, embedderThrowing);

    const res = await execute(runs, adapterOf([{ kind: 'text', content: 'hello evidence' }]));

    expect(res.status).toBe('succeeded');
    expect(calls.some((c) => c.sql.includes('evidence_fragment'))).toBe(false);
    const repr = creates.find((c) => c.table === 'derived_representation');
    expect(repr).toBeDefined();
    // Key-for-key: the shape written before this PR, no vector keys.
    expect(Object.keys(repr!.content).sort()).toEqual([
      'confidence',
      'content',
      'kind',
      'lang',
      'model',
      'modelVersion',
      'producedByRun',
      'producerVersion',
      'promptVersion',
      'subjectId',
      'subjectKind',
    ]);
    expect(repr!.content).toMatchObject({
      subjectId: ASSET,
      subjectKind: 'asset',
      kind: 'text',
      content: 'hello evidence',
      producerVersion: 'proc-v1',
    });
    expect(repr!.content.producedByRun).toBeInstanceOf(StringRecordId);
  });
});

describe('processor outputs — a locator makes the output fragment-bearing', () => {
  it('creates the fragment first and attaches the representation to it', async () => {
    const { surreal, calls, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);

    const res = await execute(
      runs,
      adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN, label: 'line 1' }]),
    );

    expect(res.status).toBe('succeeded');
    const insert = calls.find((c) => c.sql.includes('INSERT IGNORE INTO evidence_fragment'));
    expect(insert).toBeDefined();
    const row = insert!.params!.row as Record<string, unknown>;
    expect(String(row.id)).toMatch(/^evidence_fragment:[0-9a-f]{32}$/);
    expect(row.locator).toEqual(CHAR_SPAN);
    expect(row.label).toBe('line 1');
    // Media classification is inherited from the asset: a processor is
    // not a PII classifier, and the lane's fence reads the FRAGMENT.
    expect(row.piiClasses).toEqual([]);

    const repr = creates.find((c) => c.table === 'derived_representation');
    expect(repr!.content).toMatchObject({ subjectKind: 'fragment' });
    expect(String(repr!.content.subjectId)).toBe(String(row.id));
  });

  it('an unclassified asset yields an unclassified (fail-closed) fragment', async () => {
    const { surreal, calls } = surrealOf({ assetPiiClasses: undefined });
    const runs = runnerOf(surreal, embedderThrowing);

    await execute(runs, adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN }]));

    const insert = calls.find((c) => c.sql.includes('INSERT IGNORE INTO evidence_fragment'));
    const row = insert!.params!.row as Record<string, unknown>;
    expect('piiClasses' in row).toBe(false);
  });
});

describe('processor outputs — fragment dedup is by locator identity', () => {
  it('two outputs over the same span in one run share one fragment', async () => {
    const { surreal, calls, insertedFragmentIds } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);

    await execute(
      runs,
      adapterOf([
        { kind: 'text', content: 'first read', locator: CHAR_SPAN },
        { kind: 'text', content: 'second read', locator: { ...CHAR_SPAN } },
      ]),
    );

    const inserts = calls.filter((c) => c.sql.includes('INSERT IGNORE INTO evidence_fragment'));
    expect(inserts).toHaveLength(2);
    // Same deterministic id both times — the second INSERT IGNORE no-ops.
    expect(insertedFragmentIds.size).toBe(1);
  });

  it('a re-run under a bumped version reuses the SAME fragment id', async () => {
    const { surreal, calls, insertedFragmentIds } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);
    const output: ProcessorOutput = { kind: 'text', content: 'hello world', locator: CHAR_SPAN };

    const first = await execute(runs, adapterOf([output], 'proc-v1'));
    const second = await execute(runs, adapterOf([output], 'proc-v2'));

    expect(first.runId).not.toBe(second.runId);
    const ids = calls
      .filter((c) => c.sql.includes('INSERT IGNORE INTO evidence_fragment'))
      .map((c) => String((c.params!.row as { id: unknown }).id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(insertedFragmentIds.size).toBe(1);
  });

  it('supersedes over the fragment subject, not just the asset', async () => {
    const { surreal, calls } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);

    await execute(runs, adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN }]));

    const supersede = calls.find(
      (c) =>
        c.sql.includes('FROM derived_representation') && c.sql.includes('supersededBy IS NONE'),
    );
    expect(supersede).toBeDefined();
    expect(supersede!.sql).toContain('subjectId INSIDE $subjects');
    const subjects = supersede!.params!.subjects as unknown[];
    // The asset is always in scope; the run's fragment joins it.
    expect(subjects.map(String)).toEqual([ASSET, expect.stringMatching(/^evidence_fragment:/)]);
  });
});

describe('representation embeddings — EVIDENCE_FRAGMENT_EMBEDDINGS', () => {
  it('off (default): the embedder is never called and no vector key is written', async () => {
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);

    const res = await execute(
      runs,
      adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN }]),
    );

    expect(res.status).toBe('succeeded');
    const repr = creates.find((c) => c.table === 'derived_representation')!;
    expect('embedding' in repr.content).toBe(false);
    expect('embeddingSpaceId' in repr.content).toBe(false);
  });

  it('on: the vector and its space id are stored together', async () => {
    process.env.EVIDENCE_FRAGMENT_EMBEDDINGS = '1';
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderOk);

    await execute(runs, adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN }]));

    const repr = creates.find((c) => c.table === 'derived_representation')!;
    expect(repr.content.embedding).toEqual(['hello world'.length, 0.5]);
    expect(repr.content.embeddingSpaceId).toBe('openai:text-embedding-3-small:1536:l2');
  });

  it('on with no content: no call, no keys (blank text is not embeddable)', async () => {
    process.env.EVIDENCE_FRAGMENT_EMBEDDINGS = '1';
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderThrowing);

    const res = await execute(runs, adapterOf([{ kind: 'text', content: '   ' }]));

    expect(res.status).toBe('succeeded');
    const repr = creates.find((c) => c.table === 'derived_representation')!;
    expect('embedding' in repr.content).toBe(false);
  });

  it('on with no embedder wired: the row still lands without a vector', async () => {
    process.env.EVIDENCE_FRAGMENT_EMBEDDINGS = '1';
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, undefined);

    const res = await execute(runs, adapterOf([{ kind: 'text', content: 'hello world' }]));

    expect(res.status).toBe('succeeded');
    expect('embedding' in creates.find((c) => c.table === 'derived_representation')!.content).toBe(
      false,
    );
  });

  it('an embedding failure is soft: the row is written and the run succeeds', async () => {
    process.env.EVIDENCE_FRAGMENT_EMBEDDINGS = '1';
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, embedderBroken);

    const res = await execute(
      runs,
      adapterOf([{ kind: 'text', content: 'hello world', locator: CHAR_SPAN }]),
    );

    expect(res.status).toBe('succeeded');
    expect(res.representationIds).toHaveLength(1);
    const repr = creates.find((c) => c.table === 'derived_representation')!;
    expect(repr.content.content).toBe('hello world');
    expect('embedding' in repr.content).toBe(false);
  });

  it('caps embed calls per run — a many-output run cannot fan out unbounded', async () => {
    process.env.EVIDENCE_FRAGMENT_EMBEDDINGS = '1';
    let embedCalls = 0;
    const counting = {
      embed: async () => {
        embedCalls += 1;
        return [0.1];
      },
      activeSpaceId: () => 'space',
    } as unknown as EmbedderService;
    const { surreal, creates } = surrealOf({ assetPiiClasses: [] });
    const runs = runnerOf(surreal, counting);
    const outputs: ProcessorOutput[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'text' as const,
      content: `chunk ${i}`,
      locator: { kind: 'charRange' as const, start: i, end: i + 1 },
    }));

    const res = await execute(runs, adapterOf(outputs));

    expect(res.status).toBe('succeeded');
    expect(embedCalls).toBe(32);
    const reprs = creates.filter((c) => c.table === 'derived_representation');
    expect(reprs).toHaveLength(40);
    expect(reprs.filter((r) => 'embedding' in r.content)).toHaveLength(32);
  });
});
