/**
 * Fragment retrieval lane (MM-zoom PR2, profile.fragmentLane) — unit
 * coverage of the fence stack and the degrade seams, over a scripted
 * Surreal double:
 *
 *  - 0112 consent gate: absent/stale ⇒ EMPTY and NO retrieval query is
 *    ever issued (the media fence is checked before any row read);
 *  - WHERE composition: asset-join user fence (unscoped = tenant-global
 *    only; scoped adds own rows), fail-closed media PII gate on the
 *    FRAGMENT's piiClasses (lifted only by brain:read_media), and the
 *    availability != 'gone' tombstone fence;
 *  - render: one line per fragment (best-fused representation wins),
 *    [capability:<kind>] tag first, chronological order, 600-char
 *    excerpt cap, id headers + citation fence map only under withIds;
 *  - degrade: an embedder failure skips the dense leg but keeps BM25;
 *    a query failure degrades the lane to empty, never a throw;
 *  - collector gating: profile.fragmentLane off (or lane unwired) ⇒ no
 *    call, empty section.
 */
import { FragmentLaneService } from '../src/synthesize/fragment-lane.service';
import { EvidenceCollectorService } from '../src/synthesize/evidence-collector.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import { resolveRetrievalProfile, type RetrievalProfile } from '../src/search/retrieval-profile';
import {
  declaredModalitySection,
  modalitiesChecksum,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

const MANIFEST = {
  memoryModel: { modalities: ['text', 'image'] },
} as unknown as DomainPackManifest;
const CURRENT_CHECKSUM = modalitiesChecksum(declaredModalitySection(MANIFEST));

const CONSENT_ROW = {
  manifest: MANIFEST,
  acceptedModalities: true,
  acceptedModalitiesChecksum: CURRENT_CHECKSUM,
};

interface ReprRowFixture {
  id: string;
  content: string;
  kind: string;
  fragmentId: string;
  assetId: string;
  modality: string;
  occurredAt: string;
  score: number;
}

const row = (over: Partial<ReprRowFixture>): ReprRowFixture => ({
  id: 'derived_representation:r1',
  content: 'a whiteboard with the evacuation plan',
  kind: 'caption',
  fragmentId: 'evidence_fragment:f1',
  assetId: 'evidence_asset:a1',
  modality: 'image',
  occurredAt: '2026-05-01T00:00:00.000Z',
  score: 1,
  ...over,
});

/** Scripted Surreal double: routes by query text, records every call. */
function surrealOf(opts: {
  consentRows?: unknown[];
  bm25Rows?: ReprRowFixture[];
  denseRows?: ReprRowFixture[];
  failRetrieval?: boolean;
}) {
  const calls: Array<{ sql: string; params: Record<string, unknown> | undefined }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (sql.includes('FROM domain_pack')) return [opts.consentRows ?? [CONSENT_ROW]];
      if (opts.failRetrieval) throw new Error('boom');
      if (sql.includes('vector::similarity')) return [opts.denseRows ?? []];
      if (sql.includes('@1@')) return [opts.bm25Rows ?? []];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_companyId: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  return { surreal, calls };
}

const embedderOk = {
  embed: async () => [0.1, 0.2, 0.3],
} as unknown as EmbedderService;

const embedderBroken = {
  embed: async () => {
    throw new Error('no embedder');
  },
} as unknown as EmbedderService;

const baseOpts = {
  companyId: 'co_frag',
  query: 'where is the evacuation plan pinned',
  callerScopes: [] as string[],
  withIds: false,
};

describe('FragmentLaneService — consent gate (0112)', () => {
  it('consent absent ⇒ EMPTY and no retrieval query is issued', async () => {
    const { surreal, calls } = surrealOf({ consentRows: [], bm25Rows: [row({})] });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('FROM domain_pack');
  });

  it('consent STALE (checksum drift) ⇒ EMPTY', async () => {
    const { surreal, calls } = surrealOf({
      consentRows: [{ ...CONSENT_ROW, acceptedModalitiesChecksum: 'stale' }],
      bm25Rows: [row({})],
    });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('FragmentLaneService — WHERE fence composition', () => {
  async function fencesOf(opts: Partial<typeof baseOpts> & { userId?: string }) {
    const { surreal, calls } = surrealOf({ bm25Rows: [row({})] });
    await new FragmentLaneService(surreal, embedderOk).fragmentLines({ ...baseOpts, ...opts });
    return calls.filter((c) => c.sql.includes('FROM derived_representation'));
  }

  it('unscoped read: tenant-global assets only + fail-closed PII + tombstone fence', async () => {
    const retrievals = await fencesOf({});
    expect(retrievals.length).toBeGreaterThan(0);
    for (const c of retrievals) {
      expect(c.sql).toContain("subjectKind = 'fragment'");
      expect(c.sql).toContain('AND subjectId.assetId.userId IS NONE');
      expect(c.sql).not.toContain('$scopeUserId');
      expect(c.sql).toContain('AND subjectId.piiClasses = []');
      expect(c.sql).toContain("AND subjectId.assetId.availability != 'gone'");
    }
  });

  it("scoped read: caller's own assets join the tenant-global set", async () => {
    const retrievals = await fencesOf({ userId: 'u1' });
    for (const c of retrievals) {
      expect(c.sql).toContain(
        '(subjectId.assetId.userId IS NONE OR subjectId.assetId.userId = $scopeUserId)',
      );
      expect(c.params).toMatchObject({ scopeUserId: 'u1' });
    }
  });

  it('brain:read_media lifts the PII fence and nothing else', async () => {
    const retrievals = await fencesOf({ callerScopes: ['brain:read_media'] });
    for (const c of retrievals) {
      expect(c.sql).not.toContain('piiClasses');
      expect(c.sql).toContain("AND subjectId.assetId.availability != 'gone'");
    }
  });
});

describe('FragmentLaneService — render + degrade', () => {
  it('renders capability-tagged chronological lines, one per fragment, no headers without withIds', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [
        row({ id: 'derived_representation:r2', occurredAt: '2026-06-01T00:00:00.000Z' }),
        row({
          id: 'derived_representation:r3',
          fragmentId: 'evidence_fragment:f2',
          assetId: 'evidence_asset:a2',
          modality: 'audio',
          kind: 'asr',
          content: 'voice memo about the plan',
          occurredAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
    });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines(baseOpts);
    expect(out.lines).toEqual([
      '[capability:audio] (audio asr, 2026-05-01) voice memo about the plan',
      '[capability:visual] (image caption, 2026-06-01) a whiteboard with the evacuation plan',
    ]);
    expect(out.byId.size).toBe(0);
  });

  it('withIds renders the [evidence_fragment:...] header and fills the citation fence map', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({})] });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines({
      ...baseOpts,
      withIds: true,
    });
    expect(out.lines).toEqual([
      '[capability:visual] [evidence_fragment:f1] (image caption, 2026-05-01) a whiteboard with the evacuation plan',
    ]);
    expect([...out.byId.keys()]).toEqual(['evidence_fragment:f1']);
    expect(out.byId.get('evidence_fragment:f1')).toMatchObject({
      assetId: 'evidence_asset:a1',
      capability: 'visual',
      excerpt: 'a whiteboard with the evacuation plan',
    });
  });

  it('a fragment with several representations keeps ONE line (best-fused wins)', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [
        row({ id: 'derived_representation:r1', kind: 'caption', score: 2 }),
        row({ id: 'derived_representation:r4', kind: 'ocr', content: 'OCR text', score: 1 }),
      ],
    });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines(baseOpts);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('caption');
  });

  it('caps the rendered excerpt at 600 chars', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({ content: 'x'.repeat(1000) })] });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines({
      ...baseOpts,
      withIds: true,
    });
    const excerpt = out.byId.get('evidence_fragment:f1')!.excerpt;
    expect(excerpt).toHaveLength(600);
    expect(out.lines[0]!.endsWith(excerpt)).toBe(true);
  });

  it('an embedder failure skips the dense leg but keeps the BM25 leg', async () => {
    const { surreal, calls } = surrealOf({ bm25Rows: [row({})] });
    const out = await new FragmentLaneService(surreal, embedderBroken).fragmentLines(baseOpts);
    expect(out.lines).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes('vector::similarity'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('@1@'))).toBe(true);
  });

  it('a retrieval failure degrades the lane to empty — never a throw', async () => {
    const { surreal } = surrealOf({ failRetrieval: true });
    const out = await new FragmentLaneService(surreal, embedderOk).fragmentLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });
});

describe('EvidenceCollectorService — fragment lane gating', () => {
  const noSearch = { search: async () => ({ results: [] }) } as unknown as SearchService;

  function profileWith(over: Partial<RetrievalProfile>): RetrievalProfile {
    return { ...resolveRetrievalProfile({} as NodeJS.ProcessEnv), ...over } as RetrievalProfile;
  }

  function collectorWith(lane: FragmentLaneService | undefined) {
    return new EvidenceCollectorService(
      noSearch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lane,
    );
  }

  const collectArgs = (profile: RetrievalProfile, fragmentCitations = false) => ({
    profile,
    lane: null,
    companyId: 'co_frag',
    query: 'where is the plan',
    callerScopes: [] as string[],
    factIds: [] as string[],
    evidence: [] as SearchHit[],
    fragmentCitations,
  });

  it('profile.fragmentLane off ⇒ the lane is never called', async () => {
    const called: string[] = [];
    const lane = {
      fragmentLines: async (o: { query: string }) => {
        called.push(o.query);
        return { lines: ['x'], byId: new Map() };
      },
    } as unknown as FragmentLaneService;
    const out = await collectorWith(lane).collect(collectArgs(profileWith({})));
    expect(out.fragmentLines).toEqual([]);
    expect(out.fragmentsById).toBeUndefined();
    expect(called).toEqual([]);
  });

  it('profile.fragmentLane on ⇒ lines flow through; withIds mirrors the citations switch', async () => {
    const withIdsSeen: boolean[] = [];
    const lane = {
      fragmentLines: async (o: { withIds: boolean }) => {
        withIdsSeen.push(o.withIds);
        return {
          lines: ['[capability:visual] line'],
          byId: o.withIds
            ? new Map([
                [
                  'evidence_fragment:f1',
                  {
                    fragmentId: 'evidence_fragment:f1',
                    assetId: 'evidence_asset:a1',
                    capability: 'visual' as const,
                    excerpt: 'line',
                  },
                ],
              ])
            : new Map(),
        };
      },
    } as unknown as FragmentLaneService;
    const off = await collectorWith(lane).collect(collectArgs(profileWith({ fragmentLane: true })));
    expect(off.fragmentLines).toEqual(['[capability:visual] line']);
    expect(off.fragmentsById).toBeUndefined();
    const on = await collectorWith(lane).collect(
      collectArgs(profileWith({ fragmentLane: true }), true),
    );
    expect(on.fragmentsById?.size).toBe(1);
    expect(withIdsSeen).toEqual([false, true]);
  });

  it('lane unwired ⇒ empty section (partial-wiring degrade)', async () => {
    const out = await collectorWith(undefined).collect(
      collectArgs(profileWith({ fragmentLane: true })),
    );
    expect(out.fragmentLines).toEqual([]);
    expect(out.fragmentsById).toBeUndefined();
  });
});
