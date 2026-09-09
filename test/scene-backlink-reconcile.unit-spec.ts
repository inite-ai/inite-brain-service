/**
 * Scene backlink reconcile (audit 2026-09-06, note 2): the stamp is the
 * CURRENT pointer set, not a union. planBacklinkReconcile drops stale
 * pointers and only writes facts whose stamp differs; the service SETs
 * the field, reaches conversations that lost every scene on a
 * tenant-wide run, and stays in scope on a conversation-scoped one.
 */
import {
  planBacklinkReconcile,
  SceneBacklinkService,
  type BacklinkSceneHead,
} from '../src/admin/scene-backlink.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import type { SceneVersionService } from '../src/admin/scene-version';
import type { SurrealService } from '../src/db/surreal.service';

const V = SEGMENTER_VERSION;
const S1: BacklinkSceneHead = {
  id: 'memory_episode:s1',
  memberEpisodeIds: new Set(['episode:e1', 'episode:e2']),
};
const S2: BacklinkSceneHead = {
  id: 'memory_episode:s2',
  memberEpisodeIds: new Set(['episode:e3']),
};
const GONE = 'memory_episode:gone';

describe('planBacklinkReconcile', () => {
  it('computes the current set from live membership (two scenes, sorted)', () => {
    const plan = planBacklinkReconcile(
      [{ id: 'knowledge_fact:f', episodeIds: ['episode:e3', 'episode:e1'] }],
      [S2, S1],
      V,
    );
    expect(plan.linked).toEqual([{ factId: 'knowledge_fact:f', sceneIds: [S1.id, S2.id] }]);
    expect(plan.writes).toEqual([{ sceneIds: [S1.id, S2.id], factIds: ['knowledge_fact:f'] }]);
    expect(plan.stalePointersRemoved).toBe(0);
  });

  it('removes the pointer to a scene that no longer exists and keeps the live one', () => {
    const plan = planBacklinkReconcile(
      [
        {
          id: 'knowledge_fact:f',
          episodeIds: ['episode:e1'],
          memoryEpisodeIds: [S1.id, GONE],
          sceneLinkVersion: V,
        },
      ],
      [S1],
      V,
    );
    expect(plan.writes).toEqual([{ sceneIds: [S1.id], factIds: ['knowledge_fact:f'] }]);
    expect(plan.stalePointersRemoved).toBe(1);
    expect(plan.linked).toHaveLength(1);
  });

  it('a fact whose only scene was purged is set to an empty array (stamped, not linked)', () => {
    const plan = planBacklinkReconcile(
      [
        {
          id: 'knowledge_fact:f',
          episodeIds: ['episode:e9'],
          memoryEpisodeIds: [GONE],
          sceneLinkVersion: V,
        },
      ],
      [S1],
      V,
    );
    expect(plan.writes).toEqual([{ sceneIds: [], factIds: ['knowledge_fact:f'] }]);
    expect(plan.stalePointersRemoved).toBe(1);
    expect(plan.linked).toEqual([]);
  });

  it('a fact never stamped that matches no scene is left alone', () => {
    const plan = planBacklinkReconcile(
      [{ id: 'knowledge_fact:f', episodeIds: ['episode:e9'] }, { id: 'knowledge_fact:g' }],
      [S1],
      V,
    );
    expect(plan).toEqual({ linked: [], writes: [], stalePointersRemoved: 0 });
  });

  it('idempotent: a stamp equal to the current set (any order) under the same version is not rewritten', () => {
    const plan = planBacklinkReconcile(
      [
        {
          id: 'knowledge_fact:f',
          episodeIds: ['episode:e1', 'episode:e3'],
          memoryEpisodeIds: [S2.id, S1.id],
          sceneLinkVersion: V,
        },
      ],
      [S1, S2],
      V,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.linked).toHaveLength(1);
    expect(plan.stalePointersRemoved).toBe(0);
  });

  it('a stamp under another version is rewritten even when the set matches', () => {
    const plan = planBacklinkReconcile(
      [
        {
          id: 'knowledge_fact:f',
          episodeIds: ['episode:e1'],
          memoryEpisodeIds: [S1.id],
          sceneLinkVersion: `${V}+deadbeef`,
        },
      ],
      [S1],
      V,
    );
    expect(plan.writes).toEqual([{ sceneIds: [S1.id], factIds: ['knowledge_fact:f'] }]);
  });

  it('a malformed stamp (non-array, or non-string entries, or duplicates) is rewritten to the current set', () => {
    const plan = planBacklinkReconcile(
      [
        {
          id: 'knowledge_fact:str',
          episodeIds: ['episode:e1'],
          memoryEpisodeIds: S1.id,
          sceneLinkVersion: V,
        },
        {
          id: 'knowledge_fact:num',
          episodeIds: ['episode:e1'],
          memoryEpisodeIds: [42, S1.id],
          sceneLinkVersion: V,
        },
        {
          id: 'knowledge_fact:dup',
          episodeIds: ['episode:e1'],
          memoryEpisodeIds: [S1.id, S1.id],
          sceneLinkVersion: V,
        },
        {
          id: 'knowledge_fact:none',
          episodeIds: ['episode:e9'],
          memoryEpisodeIds: 'garbage',
        },
      ],
      [S1],
      V,
    );
    expect(plan.writes).toEqual([
      {
        sceneIds: [S1.id],
        factIds: ['knowledge_fact:str', 'knowledge_fact:num', 'knowledge_fact:dup'],
      },
      { sceneIds: [], factIds: ['knowledge_fact:none'] },
    ]);
    expect(plan.stalePointersRemoved).toBe(0);
  });

  it('groups facts by identical pointer set into one write each', () => {
    const plan = planBacklinkReconcile(
      [
        { id: 'knowledge_fact:a', episodeIds: ['episode:e1'] },
        { id: 'knowledge_fact:b', episodeIds: ['episode:e3'] },
        { id: 'knowledge_fact:c', episodeIds: ['episode:e2'] },
      ],
      [S1, S2],
      V,
    );
    expect(plan.writes).toEqual([
      { sceneIds: [S1.id], factIds: ['knowledge_fact:a', 'knowledge_fact:c'] },
      { sceneIds: [S2.id], factIds: ['knowledge_fact:b'] },
    ]);
  });
});

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

interface StackOpts {
  scenes?: Array<{ id: string; conversationIds: string[] }>;
  members?: Record<string, string[]>;
  factsByConversation?: Record<string, Array<Record<string, unknown>>>;
  stampedConversations?: string[];
}

function makeStack(opts: StackOpts) {
  const calls: QueryCall[] = [];
  const fakeDb = {
    async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
      calls.push({ sql, params });
      if (sql.includes('FROM memory_episode WHERE segmenterVersion')) {
        return [opts.scenes ?? []] as unknown as R;
      }
      if (sql.includes('FROM memory_episode_member WHERE in = $scene')) {
        const ids = opts.members?.[String(params?.scene)] ?? [];
        return [ids.map((out) => ({ out }))] as unknown as R;
      }
      if (sql.includes('SELECT VALUE source.conversationId')) {
        return [opts.stampedConversations ?? []] as unknown as R;
      }
      if (sql.includes('FROM knowledge_fact WHERE source.conversationId')) {
        return [opts.factsByConversation?.[String(params?.conv)] ?? []] as unknown as R;
      }
      return [[]] as unknown as R;
    },
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
  } as unknown as SurrealService;
  const fakeVersions = {
    resolve: () => ({
      version: V,
      cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
    }),
  } as unknown as SceneVersionService;
  return { svc: new SceneBacklinkService(surreal, fakeVersions), calls };
}

const updates = (calls: QueryCall[]) =>
  calls.filter((c) => c.sql.includes('UPDATE knowledge_fact')).map((c) => c.params);

describe('SceneBacklinkService.run — reconcile', () => {
  const SAVED = {
    edges: process.env.PROVENANCE_SUPPORT_EDGES,
    backlink: process.env.SCENES_FACT_BACKLINK,
  };
  beforeEach(() => {
    process.env.SCENES_FACT_BACKLINK = '1';
    delete process.env.PROVENANCE_SUPPORT_EDGES;
  });
  afterEach(() => {
    if (SAVED.edges === undefined) delete process.env.PROVENANCE_SUPPORT_EDGES;
    else process.env.PROVENANCE_SUPPORT_EDGES = SAVED.edges;
    if (SAVED.backlink === undefined) delete process.env.SCENES_FACT_BACKLINK;
    else process.env.SCENES_FACT_BACKLINK = SAVED.backlink;
  });

  it('SETs the stamp (never unions) and touches only the facts whose stamp differs', async () => {
    const { svc, calls } = makeStack({
      scenes: [{ id: S1.id, conversationIds: ['conv1'] }],
      members: { [S1.id]: ['episode:e1', 'episode:e2'] },
      factsByConversation: {
        conv1: [
          {
            id: 'knowledge_fact:current',
            episodeIds: ['episode:e1'],
            memoryEpisodeIds: [S1.id],
            sceneLinkVersion: V,
          },
          {
            id: 'knowledge_fact:stale',
            episodeIds: ['episode:e2'],
            memoryEpisodeIds: [S1.id, GONE],
            sceneLinkVersion: V,
          },
        ],
      },
    });
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 1, factsLinked: 2, stalePointersRemoved: 1 });
    expect(calls.some((c) => c.sql.includes('array::union'))).toBe(false);
    expect(updates(calls)).toEqual([
      { sceneIds: [S1.id], v: V, factIds: ['knowledge_fact:stale'] },
    ]);
  });

  it('a tenant-wide run reaches a conversation with no scene left and clears its stamps', async () => {
    const { svc, calls } = makeStack({
      scenes: [],
      stampedConversations: ['conv_gone'],
      factsByConversation: {
        conv_gone: [
          {
            id: 'knowledge_fact:orphan',
            episodeIds: ['episode:e7'],
            memoryEpisodeIds: [GONE],
            sceneLinkVersion: V,
          },
        ],
      },
    });
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 0, factsLinked: 0, stalePointersRemoved: 1 });
    expect(updates(calls)).toEqual([{ sceneIds: [], v: V, factIds: ['knowledge_fact:orphan'] }]);
  });

  it('a conversation-scoped run never scans for stamped conversations and reads only its own facts', async () => {
    const { svc, calls } = makeStack({
      scenes: [{ id: S1.id, conversationIds: ['conv1'] }],
      members: { [S1.id]: ['episode:e1'] },
      stampedConversations: ['conv_other'],
      factsByConversation: {
        conv1: [{ id: 'knowledge_fact:a', episodeIds: ['episode:e1'] }],
        conv_other: [{ id: 'knowledge_fact:x', memoryEpisodeIds: [GONE] }],
      },
    });
    const result = await svc.run('co_x', { conversationId: 'conv1' });
    expect(result).toEqual({ scenes: 1, factsLinked: 1, stalePointersRemoved: 0 });
    expect(calls.some((c) => c.sql.includes('SELECT VALUE source.conversationId'))).toBe(false);
    expect(
      calls
        .filter((c) => c.sql.includes('FROM knowledge_fact WHERE source.conversationId'))
        .map((c) => c.params?.conv),
    ).toEqual(['conv1']);
    expect(updates(calls)).toEqual([{ sceneIds: [S1.id], v: V, factIds: ['knowledge_fact:a'] }]);
  });

  it('chunks one pointer-set group into UPDATEs of at most 200 ids', async () => {
    const facts = Array.from({ length: 250 }, (_, i) => ({
      id: `knowledge_fact:f${i}`,
      episodeIds: ['episode:e1'],
    }));
    const { svc, calls } = makeStack({
      scenes: [{ id: S1.id, conversationIds: ['conv1'] }],
      members: { [S1.id]: ['episode:e1'] },
      factsByConversation: { conv1: facts },
    });
    const result = await svc.run('co_x');
    expect(result.factsLinked).toBe(250);
    const sizes = updates(calls).map((p) => (p?.factIds as unknown[]).length);
    expect(sizes).toEqual([200, 50]);
  });
});
