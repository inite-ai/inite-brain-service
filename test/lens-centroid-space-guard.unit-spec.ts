import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LensSuppressionService } from '../src/synthesize/lens-suppression.service';

/**
 * The centroid bypass (roadmap embedding-spaces-2026-09 §2 D7 / §6 E6).
 *
 * #503 (`0cd331c`) made a cross-space vector write unrepresentable — for
 * every vector that passes EmbedderService. `lens_suppression.centroid` is
 * the one that does not: the training data is offline ablation-mined, so
 * an operator POSTs the centroid to /v1/admin/lens-suppression/fit and it
 * reaches the vector store having met exactly one check, that its numbers
 * are finite. Not the width. Not the space.
 *
 * A 1536-wide centroid in a 1024-wide tenant is durable damage: the
 * governor cosine-compares it against a live query embedding, so the first
 * suppressed query raises "The two vectors must be of the same dimension".
 * And unlike every other vector column it cannot be repaired by
 * re-embedding — there is no stored source text for a centroid, so the
 * only fix is an offline re-fit.
 */

const DIM = 1024;
const SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';

function embedder(dim = DIM, space = SPACE) {
  return {
    primaryDimensions: () => dim,
    primarySpaceId: () => space,
  };
}

/** Records what actually reached the DB, so "refused" can be distinguished
 *  from "written and then complained about". */
function recordingSurreal() {
  const created: Array<Record<string, unknown>> = [];
  const surreal = {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          if (sql.includes('CREATE lens_suppression')) {
            created.push(params ?? {});
            return [null];
          }
          // The max(version) lookup.
          return [[]];
        },
      }),
  };
  return { surreal, created };
}

/** `emb` is passed positionally on purpose — a default would swallow the
 *  "no embedder wired" case this suite has to exercise. */
function service(...args: [] | [ReturnType<typeof embedder> | undefined]) {
  const emb = args.length === 0 ? embedder() : args[0];
  const { surreal, created } = recordingSurreal();
  return {
    svc: new LensSuppressionService(surreal as never, emb as never),
    created,
  };
}

const cls = (over: Partial<Record<string, unknown>> = {}) => ({
  classId: 'default',
  centroid: new Array(DIM).fill(0.01),
  suppressLanes: ['instruction'],
  sampleCount: 42,
  ...over,
});

describe('lens-suppression fit — the centroid write guard', () => {
  it('a 1536-wide centroid into a 1024 tenant is a 400, and nothing is written', async () => {
    const { svc, created } = service();
    await expect(
      svc.fitAndPersist('co1', [cls({ centroid: new Array(1536).fill(0.01) }) as never]),
    ).rejects.toMatchObject({ status: 400 });
    expect(created).toEqual([]);
  });

  it('the message names both widths and the tenant space', async () => {
    const { svc } = service();
    await expect(
      svc.fitAndPersist('co1', [cls({ centroid: [0.1, 0.2, 0.3] }) as never]),
    ).rejects.toThrow(/3-wide centroid but this tenant's corpus is 1024-wide/);
  });

  it('a declared space that is not the tenant space is a 400', async () => {
    const { svc, created } = service();
    await expect(
      svc.fitAndPersist('co1', [
        cls({ embeddingSpaceId: 'openai:text-embedding-3-small:1536:l2' }) as never,
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(created).toEqual([]);
  });

  it('a right-width centroid persists and is stamped with the tenant space', async () => {
    const { svc, created } = service();
    const res = await svc.fitAndPersist('co1', [cls() as never]);
    expect(res).toEqual({ persisted: 1, classes: ['default'] });
    expect(created).toHaveLength(1);
    expect(created[0]!.embeddingSpaceId).toBe(SPACE);
  });

  it('a matching declared space is accepted and stamped', async () => {
    const { svc, created } = service();
    await svc.fitAndPersist('co1', [cls({ embeddingSpaceId: SPACE }) as never]);
    expect(created[0]!.embeddingSpaceId).toBe(SPACE);
  });

  it('one bad centroid in a batch persists NOTHING — the check runs before any write', async () => {
    const { svc, created } = service();
    await expect(
      svc.fitAndPersist('co1', [
        cls({ classId: 'good' }) as never,
        cls({ classId: 'bad', centroid: new Array(1536).fill(0.01) }) as never,
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(created).toEqual([]);
  });

  it('no embedder ⇒ the width is unknowable ⇒ 503, not a write', async () => {
    // Fail closed. An unvalidated centroid is durable and unrepairable; a
    // 503 is retryable.
    const { svc, created } = service(undefined);
    await expect(svc.fitAndPersist('co1', [cls() as never])).rejects.toMatchObject({
      status: 503,
    });
    expect(created).toEqual([]);
  });

  it('the guard follows the PRIMARY space, so a warmup failover cannot widen it', async () => {
    // primaryDimensions()/primarySpaceId() are stable across the bge-m3
    // warmup window, unlike getDimensions()/activeSpaceId(). The ingest
    // therefore neither accepts a 1536 centroid during warmup nor 503s for
    // a correct one.
    const { svc, created } = service(embedder(1024, SPACE));
    await svc.fitAndPersist('co1', [cls() as never]);
    expect(created[0]!.embeddingSpaceId).toBe(SPACE);
  });
});

describe('migration 0132 — the stamp columns', () => {
  const DIR = join(__dirname, '..', 'src', 'db', 'migrations');
  const sql = readFileSync(join(DIR, '0132_lens_centroid_space.surql'), 'utf8');
  /** Prose explaining a rule must not trip the rule (the truth-gate idiom). */
  const ddl = sql.replace(/^\s*--.*$/gm, '');

  it('takes a migration number nothing else on main uses', () => {
    // migrationId is UNIQUE in schema_migrations: two branches shipping the
    // same number means one of them silently never applies.
    const numbers = readdirSync(DIR)
      .filter((f) => f.endsWith('.surql'))
      .map((f) => f.slice(0, 4));
    expect(numbers.filter((n) => n === '0132')).toHaveLength(1);
  });

  it('stamps both columns 0101 missed, additively', () => {
    for (const table of ['lens_suppression', 'semantic_belief']) {
      expect(ddl).toContain(
        `DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON ${table} TYPE option<string>`,
      );
    }
    // option<> so existing rows read NONE and no backfill runs at migrate
    // time (the 0101 posture).
    expect(ddl).not.toMatch(/TYPE string/);
    // No data mutation and no index: 3.2.4's planner mishandles
    // UPDATE/DELETE … WHERE over an indexed field.
    expect(ddl).not.toMatch(/\b(UPDATE|DELETE|CREATE|UPSERT)\b/);
    expect(ddl).not.toMatch(/DEFINE INDEX/);
  });
});
