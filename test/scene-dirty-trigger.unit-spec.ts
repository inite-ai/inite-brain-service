/**
 * Unit coverage for the dirty-conversation trigger (migration 0130):
 * the three SQL verbs in src/common/scene-dirty.ts (mark by primary key,
 * bounded oldest-first page, two-step race-fenced clear) and the ingest
 * seam that writes the mark (EpisodeStoreService.captureTurn) — including
 * the default-off pin: with either scene flag off, capture issues exactly
 * the queries it issued before this feature existed.
 */
import {
  clearDirtyConversations,
  markConversationDirty,
  selectDirtyConversations,
  type SceneDirtyDb,
} from '../src/common/scene-dirty';
import { EpisodeStoreService } from '../src/ingest/episode-store.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

interface Seen {
  sql: string;
  params: Record<string, unknown> | undefined;
}

function fakeDb(reply: (sql: string) => unknown): { db: SceneDirtyDb; seen: Seen[] } {
  const seen: Seen[] = [];
  const db: SceneDirtyDb = {
    query: async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      seen.push({ sql, params });
      return reply(sql) as T;
    },
  };
  return { db, seen };
}

describe('scene-dirty — mark', () => {
  it('UPSERTs by PRIMARY KEY (no read-modify-write, burst-collapsing)', async () => {
    const { db, seen } = fakeDb(() => [[]]);
    await markConversationDirty(db, 'proj:alpha');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain('UPSERT scene_dirty_conversation:[$conv]');
    expect(seen[0]!.sql).toContain('markedAt = time::now()');
    // createdAt is deliberately NOT restated — its DEFAULT records the
    // first-marked instant across a burst of turns.
    expect(seen[0]!.sql).not.toContain('createdAt');
    expect(seen[0]!.params).toEqual({ conv: 'proj:alpha' });
  });

  it('never issues an UPDATE/DELETE over a secondary index (3.2.4 discipline)', async () => {
    const { db, seen } = fakeDb(() => [[]]);
    await markConversationDirty(db, 'c1');
    expect(seen[0]!.sql).not.toMatch(/UPDATE scene_dirty_conversation\s+SET/);
    expect(seen[0]!.sql).not.toContain('WHERE conversationId');
  });
});

describe('scene-dirty — select', () => {
  it('reads a bounded page, oldest mark first', async () => {
    const rows = [
      { id: `scene_dirty_conversation:['a']`, conversationId: 'a' },
      { id: `scene_dirty_conversation:['b']`, conversationId: 'b' },
    ];
    const { db, seen } = fakeDb(() => [rows]);
    await expect(selectDirtyConversations(db, 25)).resolves.toEqual(rows);
    expect(seen[0]!.sql).toContain('ORDER BY markedAt ASC LIMIT $limit');
    expect(seen[0]!.params).toEqual({ limit: 25 });
  });

  it('floors a fractional limit and refuses a non-positive one without a query', async () => {
    const { db, seen } = fakeDb(() => [[]]);
    await selectDirtyConversations(db, 7.9);
    expect(seen[0]!.params).toEqual({ limit: 7 });
    await expect(selectDirtyConversations(db, 0)).resolves.toEqual([]);
    await expect(selectDirtyConversations(db, -1)).resolves.toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('drops malformed rows rather than composing an undefined conversation', async () => {
    const { db } = fakeDb(() => [[{ id: 'x' }, { id: 'y', conversationId: 'ok' }]]);
    await expect(selectDirtyConversations(db, 10)).resolves.toEqual([
      { id: 'y', conversationId: 'ok' },
    ]);
  });
});

describe('scene-dirty — clear', () => {
  it('resolves ids first, then deletes BY ID (LET-select-ids idiom)', async () => {
    const ids = ['scene_dirty_conversation:[a]', 'scene_dirty_conversation:[b]'];
    const readAt = new Date('2026-03-01T04:20:00.000Z');
    const { db, seen } = fakeDb((sql) => (sql.includes('SELECT VALUE id') ? [ids] : [[]]));
    await expect(clearDirtyConversations(db, ids, readAt)).resolves.toBe(2);
    expect(seen).toHaveLength(2);
    // Step 1 carries the race fence: only marks that predate the read.
    expect(seen[0]!.sql).toContain('SELECT VALUE id FROM scene_dirty_conversation');
    expect(seen[0]!.sql).toContain('markedAt <= $readAt');
    expect(seen[0]!.params).toEqual({ ids, readAt });
    // Step 2 addresses primary keys only.
    expect(seen[1]!.sql).toBe('DELETE scene_dirty_conversation WHERE id INSIDE $doomed');
    expect(seen[1]!.params).toEqual({ doomed: ids });
  });

  it('a mark re-bumped DURING the pass survives — nothing is deleted', async () => {
    // The fence matched nothing: every candidate was re-marked after readAt.
    const { db, seen } = fakeDb((sql) => (sql.includes('SELECT VALUE id') ? [[]] : [[]]));
    await expect(clearDirtyConversations(db, ['x'], new Date())).resolves.toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain('SELECT VALUE id');
  });

  it('an empty id list issues no query at all', async () => {
    const { db, seen } = fakeDb(() => [[]]);
    await expect(clearDirtyConversations(db, [], new Date())).resolves.toBe(0);
    expect(seen).toHaveLength(0);
  });
});

// ── the ingest seam ─────────────────────────────────────────────────────

function dto(partial: Partial<IngestMentionDto> = {}): IngestMentionDto {
  return {
    text: 'I booked the Lisbon flight',
    contextRef: { vertical: 'proj', conversationId: 'proj:alpha', messageId: 'm-1' },
    knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
    emittedAt: '2026-03-01T12:00:00.000Z',
    ...partial,
  } as IngestMentionDto;
}

function makeStore(opts: { markThrows?: boolean } = {}): {
  svc: EpisodeStoreService;
  queries: string[];
} {
  const queries: string[] = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith('INSERT IGNORE')) return [[{ id: 'episode:e1' }]];
          if (sql.startsWith('UPSERT scene_dirty_conversation')) {
            if (opts.markThrows) throw new Error('mark blew up');
            return [[]];
          }
          return [[]];
        },
      }),
  } as unknown as SurrealService;
  return { svc: new EpisodeStoreService(surreal), queries };
}

const ENV = [
  'EPISODE_SUBSTRATE_ENABLED',
  'SCENES_SEGMENTATION_ENABLED',
  'SCENES_SCHEDULED_MAINTENANCE',
] as const;

describe('EpisodeStoreService — the dirty-mark seam', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const marks = (queries: string[]) =>
    queries.filter((q) => q.startsWith('UPSERT scene_dirty_conversation'));

  it('PIN: both scene flags off ⇒ capture issues ONLY the INSERT', async () => {
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:e1');
    expect(queries).toEqual(['INSERT IGNORE INTO episode $row']);
  });

  it('PIN: the master flag alone does not mark (marks must not outlive a disabled composer)', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    const { svc, queries } = makeStore();
    await svc.captureTurn('co_x', dto());
    expect(marks(queries)).toHaveLength(0);
  });

  it('PIN: the maintenance flag alone does not mark either', async () => {
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    const { svc, queries } = makeStore();
    await svc.captureTurn('co_x', dto());
    expect(marks(queries)).toHaveLength(0);
  });

  it('marks the conversation when BOTH flags are on', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:e1');
    expect(marks(queries)).toHaveLength(1);
  });

  it('a turn without a conversationId has nothing to mark', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    const { svc, queries } = makeStore();
    await svc.captureTurn('co_x', dto({ contextRef: { vertical: 'proj', messageId: 'm-9' } }));
    expect(marks(queries)).toHaveLength(0);
  });

  it('a failing mark never costs the captured episode its id', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    const { svc } = makeStore({ markThrows: true });
    // The fail-closed capture path reads this return value — a swallowed
    // mark failure must not turn a stored turn into a rejected mention.
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:e1');
  });

  it('marks on the DUPLICATE path too (a replay after a failed compose)', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    const queries: string[] = [];
    const surreal = {
      withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string) => {
            queries.push(sql);
            // INSERT IGNORE swallowed the duplicate: no row returned.
            if (sql.startsWith('INSERT IGNORE')) return [[]];
            if (sql.startsWith('SELECT VALUE id')) return [['episode:existing']];
            return [[]];
          },
        }),
    } as unknown as SurrealService;
    const svc = new EpisodeStoreService(surreal);
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:existing');
    expect(marks(queries)).toHaveLength(1);
  });
});
