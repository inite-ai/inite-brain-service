/**
 * Multilingual Tier 3 — reversible entity resolution
 * (MULTILINGUAL_ENTITY_REVERSIBLE, migration 0102).
 *
 * OFF (default): a `same` judge verdict on an embedding-only candidate is
 * reused IMMEDIATELY and nothing is logged — byte-identical to pre-0102.
 * ON: the weak match is NOT auto-merged; a reviewable entity_merge_log
 * candidate row is written and resolveByName returns null (the caller mints
 * a fresh entity), so the fuse is deferred to explicit, reversible review.
 */
import { EntityResolverService } from '../src/ingest/entity-resolver.service';

const CONFIG_VALUES: Record<string, string> = {
  INGEST_INLINE_RESOLUTION_ENABLED: '1',
};

const config = {
  get: (key: string, def?: string) => CONFIG_VALUES[key] ?? def,
} as any;

const embedder = {
  embed: async () => [0.1, 0.2, 0.3],
} as any;

const judge = {
  isAvailable: () => true,
  fetchTopFacts: async () => 'existing: facts',
  judge: async () => 'same',
} as any;

/** A fake Surreal `db` that answers the name-candidate scan and captures
 *  every CREATE (the merge-log write). */
function makeDb(opts: { createThrows?: boolean } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('CREATE type::table')) {
        if (opts.createThrows) throw new Error('merge-log write failed');
        creates.push((params?.d ?? {}) as Record<string, unknown>);
        return [[{ id: 'entity_merge_log:1' }]];
      }
      // The name-candidate full scan → one strong-cosine same-type hit.
      return [[{ entityId: 'knowledge_entity:existing', etype: 'customer', sim: 0.9 }]];
    },
  } as any;
  return { db, creates };
}

const OLD = process.env.MULTILINGUAL_ENTITY_REVERSIBLE;
afterEach(() => {
  if (OLD === undefined) delete process.env.MULTILINGUAL_ENTITY_REVERSIBLE;
  else process.env.MULTILINGUAL_ENTITY_REVERSIBLE = OLD;
});

const resolver = () => new EntityResolverService(config, embedder, judge);

const call = (db: any) =>
  resolver().resolveByName({
    db,
    name: 'Acme',
    type: 'customer',
    incomingFacts: ['industry: tech'],
  });

describe('reversible resolution OFF (default) — byte-identical', () => {
  it('reuses the candidate id immediately and writes NO merge log', async () => {
    delete process.env.MULTILINGUAL_ENTITY_REVERSIBLE;
    const { db, creates } = makeDb();
    const id = await call(db);
    expect(id).toBe('knowledge_entity:existing');
    expect(creates).toHaveLength(0);
  });
});

describe('reversible resolution ON', () => {
  it('does NOT auto-merge a weak embedding match — writes a candidate row', async () => {
    process.env.MULTILINGUAL_ENTITY_REVERSIBLE = '1';
    const { db, creates } = makeDb();
    const id = await call(db);
    // Weak match deferred: caller mints a fresh entity.
    expect(id).toBeNull();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      mention: 'Acme',
      mentionType: 'customer',
      targetEntity: 'knowledge_entity:existing',
      verdict: 'same',
      cosine: 0.9,
      matchKind: 'embedding',
      decision: 'candidate',
      reviewState: 'pending',
    });
  });

  it('never blocks ingest when the merge-log write fails', async () => {
    process.env.MULTILINGUAL_ENTITY_REVERSIBLE = '1';
    const { db } = makeDb({ createThrows: true });
    // recordMerge swallows the error; resolveByName still returns null.
    await expect(call(db)).resolves.toBeNull();
  });
});

describe('recordMerge — reused row carries no reviewState', () => {
  it('omits reviewState for a deterministic reused decision', async () => {
    const { db, creates } = makeDb();
    await resolver().recordMerge(db, {
      mention: 'Acme',
      type: 'customer',
      targetEntity: 'knowledge_entity:existing',
      verdict: 'same',
      cosine: 1,
      matchKind: 'exact',
      decision: 'reused',
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ decision: 'reused', matchKind: 'exact' });
    expect(creates[0]).not.toHaveProperty('reviewState');
  });
});
