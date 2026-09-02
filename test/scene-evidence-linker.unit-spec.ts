/**
 * Scene evidence linker (MM-zoom PR1, SCENES_EVIDENCE_LINKS —
 * reconstructed_from edges scene → fragment|asset, 0123). Pins the
 * flag-off zero-query guarantee, the graceful no-op when member
 * episodes carry no evidence refs (the metadata-ingest producer may not
 * have run), the INSERT RELATION IGNORE payload shape (writer
 * scene_evidence_linker, writerVersion = the effective segmenter
 * version), and the pure ref filter (evidenceLinkTargets — fragment/
 * asset classes only, 'episode:' membership refs excluded).
 */
import {
  SceneEvidenceLinkerService,
  evidenceLinkTargets,
} from '../src/admin/scene-evidence-linker.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import type { SceneVersionService } from '../src/admin/scene-version';
import type { SurrealService } from '../src/db/surreal.service';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

const SAVED = { links: process.env.SCENES_EVIDENCE_LINKS };
afterEach(() => {
  if (SAVED.links === undefined) delete process.env.SCENES_EVIDENCE_LINKS;
  else process.env.SCENES_EVIDENCE_LINKS = SAVED.links;
});

describe('evidenceLinkTargets (pure ref filter)', () => {
  it('keeps fragment/asset refs, drops episode/membership refs and malformed lists', () => {
    expect(
      evidenceLinkTargets([
        ['evidence_fragment:fr1', 'episode:e1', 'evidence_asset:a1'],
        'not-a-list',
        null,
        ['evidence_fragment:fr1', 'knowledge_fact:f1', 42],
      ]),
    ).toEqual(['evidence_fragment:fr1', 'evidence_asset:a1']);
    expect(evidenceLinkTargets([])).toEqual([]);
    expect(evidenceLinkTargets([undefined, {}])).toEqual([]);
  });
});

describe('SceneEvidenceLinkerService — reconstructed_from edges', () => {
  function makeStack(refLists: unknown[]) {
    const calls: QueryCall[] = [];
    const fakeDb = {
      async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
        calls.push({ sql, params });
        if (sql.includes('FROM memory_episode WHERE segmenterVersion')) {
          return [[{ id: 'memory_episode:s1' }]] as unknown as R;
        }
        if (sql.includes('FROM memory_episode_member WHERE in = $scene')) {
          return [[{ out: 'episode:e1' }, { out: 'episode:e2' }]] as unknown as R;
        }
        if (sql.includes('SELECT VALUE source.evidenceRefs FROM episode')) {
          return [refLists] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
    } as unknown as SurrealService;
    // Fingerprint flag off in the unit env ⇒ the real service resolves to
    // the literal SEGMENTER_VERSION; the stub pins that same contract
    // (support-edge-writers.unit-spec pattern).
    const fakeVersions = {
      resolve: () => ({
        version: SEGMENTER_VERSION,
        cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
      }),
    } as unknown as SceneVersionService;
    return { svc: new SceneEvidenceLinkerService(surreal, fakeVersions), calls };
  }

  it('flag OFF (default): ZERO queries — byte-identical prod', async () => {
    delete process.env.SCENES_EVIDENCE_LINKS;
    const { svc, calls } = makeStack([]);
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 0, scenesLinked: 0, edges: 0 });
    expect(calls).toEqual([]);
  });

  it('flag ON, refs present: INSERT RELATION IGNORE with scene→fragment/asset rows only', async () => {
    process.env.SCENES_EVIDENCE_LINKS = '1';
    const { svc, calls } = makeStack([
      ['evidence_fragment:fr1', 'episode:e1'],
      ['evidence_asset:a1', 'evidence_fragment:fr1'], // dupe deduped
    ]);
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 1, scenesLinked: 1, edges: 2 });
    const insert = calls.find((c) => c.sql.includes('INSERT RELATION IGNORE INTO memory_support'));
    expect(insert).toBeDefined();
    const rows = insert!.params!.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => ({ ...r, in: String(r.in), out: String(r.out) }))).toEqual([
      {
        in: 'memory_episode:s1',
        out: 'evidence_fragment:fr1',
        kind: 'reconstructed_from',
        writer: 'scene_evidence_linker',
        writerVersion: SEGMENTER_VERSION,
      },
      {
        in: 'memory_episode:s1',
        out: 'evidence_asset:a1',
        kind: 'reconstructed_from',
        writer: 'scene_evidence_linker',
        writerVersion: SEGMENTER_VERSION,
      },
    ]);
  });

  it('flag ON, NO evidence refs anywhere: graceful no-op — reads happen, ZERO writes', async () => {
    process.env.SCENES_EVIDENCE_LINKS = '1';
    // SELECT VALUE of a missing FLEXIBLE key yields NONE per row.
    const { svc, calls } = makeStack([undefined, undefined]);
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 1, scenesLinked: 0, edges: 0 });
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('UPDATE'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('DELETE'))).toBe(false);
  });

  it('conversationId opt narrows the scene SELECT (the backlink filter shape)', async () => {
    process.env.SCENES_EVIDENCE_LINKS = '1';
    const { svc, calls } = makeStack([]);
    await svc.run('co_x', { conversationId: 'conv1' });
    expect(calls[0]!.sql).toContain('AND conversationIds CONTAINS $conv');
    expect(calls[0]!.params).toMatchObject({ conv: 'conv1' });
  });
});
