import { EvidenceCollectorService } from '../src/synthesize/evidence-collector.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SegmentLaneService } from '../src/synthesize/segment-lane.service';
import type { MentionScanService } from '../src/synthesize/mention-scan.service';
import type { UpdateStoryService } from '../src/synthesize/update-story.service';
import {
  resolveRetrievalProfile,
  type RetrievalProfile,
} from '../src/search/retrieval-profile';

/**
 * The collector's branch matrix (V9 quality pass) — the degrade and
 * fallback seams that moved out of the orchestrator and lost their
 * implicit coverage: 'scan'-routed queries falling back to the top-K
 * segment appendix when MentionScanService is not wired; update-story
 * gating (profile off / no fact ids); the instruction-probe failure
 * degrading to evidence-only instead of failing the answer.
 */

const ORDER_QUERY = 'In what order did I raise the parser project aspects?';

function profileWith(over: Partial<RetrievalProfile>): RetrievalProfile {
  return {
    ...resolveRetrievalProfile({} as NodeJS.ProcessEnv),
    ...over,
  } as RetrievalProfile;
}

const noSearch = {
  search: async () => ({ results: [] }),
} as unknown as SearchService;

function collectorArgs(profile: RetrievalProfile) {
  return {
    profile,
    lane: null,
    companyId: 'c1',
    query: ORDER_QUERY,
    callerScopes: [],
    factIds: [] as string[],
    evidence: [] as SearchHit[],
  };
}

describe('EvidenceCollectorService branches', () => {
  it("timeline 'scan' without MentionScanService falls back to the segment appendix", async () => {
    const segmentCalls: string[] = [];
    const segmentLane = {
      transcriptLines: async (o: { query: string }) => {
        segmentCalls.push(o.query);
        return ['[2026-01-02] user: parser project note'];
      },
    } as unknown as SegmentLaneService;
    const svc = new EvidenceCollectorService(
      noSearch,
      undefined,
      segmentLane,
      undefined,
      undefined, // mentionScan NOT wired
      undefined,
      undefined,
    );
    const out = await svc.collect(
      collectorArgs(profileWith({ timelineEvidence: 'scan' })),
    );
    expect(out.timelineEvidence).toBe(true);
    expect(segmentCalls).toHaveLength(1);
    expect(out.transcriptLines).toEqual(['[2026-01-02] user: parser project note']);
  });

  it("timeline 'scan' with the lane wired routes to mention-scan, not the appendix", async () => {
    const segmentCalls: string[] = [];
    const segmentLane = {
      transcriptLines: async (o: { query: string }) => {
        segmentCalls.push(o.query);
        return ['appendix line'];
      },
    } as unknown as SegmentLaneService;
    const mentionScan = {
      mentionLines: async () => ['[2026-01-02] mention line'],
    } as unknown as MentionScanService;
    const svc = new EvidenceCollectorService(
      noSearch,
      undefined,
      segmentLane,
      undefined,
      mentionScan,
      undefined,
      undefined,
    );
    const out = await svc.collect(
      collectorArgs(profileWith({ timelineEvidence: 'scan' })),
    );
    expect(out.transcriptLines).toEqual(['[2026-01-02] mention line']);
    expect(segmentCalls).toHaveLength(0);
  });

  it('update stories gate on the profile flag AND non-empty factIds', async () => {
    const storyCalls: string[][] = [];
    const updateStory = {
      previousStories: async (o: { factIds: string[] }) => {
        storyCalls.push(o.factIds);
        return new Map([['f1', ' [previously: old]']]);
      },
    } as unknown as UpdateStoryService;
    const make = () =>
      new EvidenceCollectorService(
        noSearch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        updateStory,
      );

    // Flag off → no call, undefined.
    const off = await make().collect(
      collectorArgs(profileWith({ updateStoryRendering: false })),
    );
    expect(off.updateStories).toBeUndefined();

    // Flag on, no fact ids → no call.
    const empty = await make().collect(
      collectorArgs(profileWith({ updateStoryRendering: true })),
    );
    expect(empty.updateStories).toBeUndefined();
    expect(storyCalls).toHaveLength(0);

    // Flag on + fact ids → the map comes through.
    const on = await make().collect({
      ...collectorArgs(profileWith({ updateStoryRendering: true })),
      factIds: ['f1'],
    });
    expect(on.updateStories?.get('f1')).toBe(' [previously: old]');
    expect(storyCalls).toEqual([['f1']]);
  });

  it('an instruction-probe failure degrades to evidence-only', async () => {
    const search = {
      search: async () => {
        throw new Error('probe down');
      },
    } as unknown as SearchService;
    const svc = new EvidenceCollectorService(search);
    const profile = profileWith({});
    (profile as { lanes: ReadonlySet<string> }).lanes = new Set([
      'instruction',
    ]);
    const out = await svc.collect(collectorArgs(profile));
    // No instructions section (probe died, evidence empty) — but the
    // collect itself succeeded.
    expect(out.instructions).toBeUndefined();
    expect(out.transcriptLines).toEqual([]);
  });

  it('assistant lane gates on its own flag and joins the transcript set', async () => {
    const calls: Array<{ limit: number; match: string }> = [];
    const episodeLane = {
      assistantTurns: async (o: { limit: number; match: string }) => {
        calls.push({ limit: o.limit, match: o.match });
        return ['[2023-05-01] conv__assistant: use the token bucket'];
      },
    } as unknown as import('../src/synthesize/episode-lane.service').EpisodeLaneService;
    const make = () => new EvidenceCollectorService(noSearch, episodeLane);

    const off = await make().collect(
      collectorArgs(profileWith({ assistantLane: false })),
    );
    expect(off.transcriptLines).toEqual([]);
    expect(calls).toHaveLength(0);

    const on = await make().collect(
      collectorArgs(
        profileWith({
          assistantLane: true,
          assistantLaneTopK: 6,
          assistantLaneMatch: 'assistant',
        }),
      ),
    );
    expect(on.transcriptLines).toEqual([
      '[2023-05-01] conv__assistant: use the token bucket',
    ]);
    expect(calls).toEqual([{ limit: 6, match: 'assistant' }]);
  });

  it('digest lane threads the caller userId through (0087 — no more hard fail-close)', async () => {
    const calls: Array<{ companyId: string; userId?: string }> = [];
    const digestLane = {
      digestLines: async (o: { companyId: string; userId?: string }) => {
        calls.push(o);
        return ['digest line'];
      },
    } as unknown as import('../src/synthesize/digest-lane.service').DigestLaneService;
    const svc = new EvidenceCollectorService(
      noSearch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      digestLane,
    );
    const out = await svc.collect({
      ...collectorArgs(profileWith({ digestEvidence: true })),
      userId: 'user-b',
    });
    // Pre-0087 a user-scoped caller was hard fail-closed to []; the
    // lane now applies the userScopes policy itself in SQL.
    expect(out.insightLines).toEqual(['digest line']);
    expect(calls).toEqual([{ companyId: 'c1', userId: 'user-b' }]);
  });

  it('strategy notes gate on lane membership AND the read-side flag', async () => {
    const calls: string[] = [];
    const makeStrategy = (retrievalOn: boolean) =>
      ({
        isRetrievalEnabled: () => retrievalOn,
        retrieve: async (_companyId: string, query: string) => {
          calls.push(query);
          return [
            {
              strategyId: 'strategy_memory:s1',
              title: 'check temporal shape',
              situation: 'temporal questions',
              strategy: 'Compute from the date table.',
              polarity: 'do',
              similarity: 0.9,
            },
          ];
        },
      }) as unknown as import('../src/strategy/strategy-memory.service').StrategyMemoryService;
    const make = (retrievalOn: boolean) =>
      new EvidenceCollectorService(
        noSearch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        makeStrategy(retrievalOn),
      );

    // Lane off the profile → no call, undefined.
    const laneOff = await make(true).collect(collectorArgs(profileWith({})));
    expect(laneOff.strategyNotes).toBeUndefined();
    expect(calls).toHaveLength(0);

    // Lane on, read-side flag off → no call, undefined.
    const laneOnProfile = profileWith({});
    (laneOnProfile as { lanes: ReadonlySet<string> }).lanes = new Set([
      'strategy',
    ]);
    const servingOff = await make(false).collect(collectorArgs(laneOnProfile));
    expect(servingOff.strategyNotes).toBeUndefined();
    expect(calls).toHaveLength(0);

    // Lane on + serving on → rendered advisory notes.
    const on = await make(true).collect(collectorArgs(laneOnProfile));
    expect(on.strategyNotes).toEqual([
      '[DO] check temporal shape — applies when: temporal questions. Compute from the date table.',
    ]);
    expect(calls).toEqual([ORDER_QUERY]);
  });

  it('a strategy retrieval failure degrades to no advisory section', async () => {
    const strategy = {
      isRetrievalEnabled: () => true,
      retrieve: async () => {
        throw new Error('strategy store down');
      },
    } as unknown as import('../src/strategy/strategy-memory.service').StrategyMemoryService;
    const svc = new EvidenceCollectorService(
      noSearch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      strategy,
    );
    const profile = profileWith({});
    (profile as { lanes: ReadonlySet<string> }).lanes = new Set(['strategy']);
    const out = await svc.collect(collectorArgs(profile));
    expect(out.strategyNotes).toBeUndefined();
    expect(out.transcriptLines).toEqual([]);
  });

  it('grounding quotes gate on factsAsKeys AND factIds, capped best-first', async () => {
    const seen: string[][] = [];
    const episodeLane = {
      groundingQuotes: async (o: { factIds: string[] }) => {
        seen.push(o.factIds);
        return new Map([['f1', ' [source 2023-05-01 Mel: "dog face"]']]);
      },
    } as unknown as import('../src/synthesize/episode-lane.service').EpisodeLaneService;
    const make = () => new EvidenceCollectorService(noSearch, episodeLane);

    const off = await make().collect(
      collectorArgs(profileWith({ factsAsKeys: false })),
    );
    expect(off.groundingQuotes).toBeUndefined();
    expect(seen).toHaveLength(0);

    const empty = await make().collect(
      collectorArgs(profileWith({ factsAsKeys: true })),
    );
    expect(empty.groundingQuotes).toBeUndefined();
    expect(seen).toHaveLength(0);

    const on = await make().collect({
      ...collectorArgs(profileWith({ factsAsKeys: true, factsAsKeysCap: 2 })),
      factIds: ['f1', 'f2', 'f3'],
    });
    expect(on.groundingQuotes?.get('f1')).toBe(
      ' [source 2023-05-01 Mel: "dog face"]',
    );
    // Cap applies to the BEST evidence facts (input order).
    expect(seen).toEqual([['f1', 'f2']]);
  });
});

/**
 * V11 item 10 — cross-user prompt isolation at the collector seam.
 * Every lane stub models the DB user fence: user A's content comes
 * back only to a tenant-global caller (no userId) or to A itself. If
 * the collector forgets to thread userId into ANY lane call, A's
 * content leaks into the assembled evidence and the assertions below
 * catch it in that section.
 */
describe('cross-user evidence isolation (V11 item 10)', () => {
  const A_SECRET = 'A-SECRET: user A rents a flat in Lisbon';
  const laneCalls: Array<{ lane: string; userId?: string | undefined }> = [];
  const scopedLines = (lane: string, userId: string | undefined): string[] => {
    laneCalls.push({ lane, userId });
    return userId === undefined || userId === 'user-a'
      ? [`[2026-01-01] ${lane}: ${A_SECRET}`]
      : [];
  };
  const scopedMap = (
    lane: string,
    userId: string | undefined,
  ): Map<string, string> => {
    laneCalls.push({ lane, userId });
    return userId === undefined || userId === 'user-a'
      ? new Map([['f1', ` [${lane}: ${A_SECRET}]`]])
      : new Map();
  };

  function makeIsolationCollector(): EvidenceCollectorService {
    const episodeLane = {
      transcriptLines: async (o: { userId?: string }) =>
        scopedLines('episode', o.userId),
      sourceExcerpts: async (o: { userId?: string }) =>
        scopedLines('excerpt', o.userId),
      rawWindows: async (o: { userId?: string }) =>
        scopedLines('raw-window', o.userId),
      assistantTurns: async (o: { userId?: string }) =>
        scopedLines('assistant', o.userId),
      groundingQuotes: async (o: { userId?: string }) =>
        scopedMap('grounding', o.userId),
    } as unknown as import('../src/synthesize/episode-lane.service').EpisodeLaneService;
    const segmentLane = {
      transcriptLines: async (o: { userId?: string }) =>
        scopedLines('segment', o.userId),
    } as unknown as SegmentLaneService;
    const insightLane = {
      insightLines: async (o: { userId?: string }) =>
        scopedLines('insight', o.userId),
    } as unknown as import('../src/synthesize/insight-lane.service').InsightLaneService;
    const updateStory = {
      previousStories: async (o: { userId?: string }) =>
        scopedMap('update-story', o.userId),
    } as unknown as UpdateStoryService;
    const digestLane = {
      digestLines: async (o: { userId?: string }) =>
        scopedLines('digest', o.userId),
    } as unknown as import('../src/synthesize/digest-lane.service').DigestLaneService;
    return new EvidenceCollectorService(
      noSearch,
      episodeLane,
      segmentLane,
      insightLane,
      undefined,
      undefined,
      updateStory,
      digestLane,
    );
  }

  // Every user-fenced lane on at once — the widest prompt surface.
  const fullProfile = () =>
    profileWith({
      verbatimEvidence: 'always',
      insightEvidence: 'routed',
      digestEvidence: true,
      updateStoryRendering: true,
      factsAsKeys: true,
      rawWindow: true,
      assistantLane: true,
    });

  function isolationArgs(userId?: string) {
    return {
      ...collectorArgs(fullProfile()),
      lane: 'summary' as const,
      factIds: ['f1'],
      ...(userId !== undefined ? { userId } : {}),
    };
  }

  const flattenSections = (
    out: Awaited<ReturnType<EvidenceCollectorService['collect']>>,
  ): string =>
    [
      ...out.transcriptLines,
      ...out.insightLines,
      ...(out.instructions ?? []),
      ...(out.updateStories ? [...out.updateStories.values()] : []),
      ...(out.groundingQuotes ? [...out.groundingQuotes.values()] : []),
    ].join('\n');

  it("a tenant-global caller DOES see A's content (the stubs would leak)", async () => {
    laneCalls.length = 0;
    const out = await makeIsolationCollector().collect(isolationArgs());
    expect(flattenSections(out)).toContain('A-SECRET');
  });

  it("user B's collect surfaces A's content in NO section, every lane user-scoped", async () => {
    laneCalls.length = 0;
    const out = await makeIsolationCollector().collect(
      isolationArgs('user-b'),
    );
    expect(flattenSections(out)).not.toContain('A-SECRET');
    // Not vacuous: every user-fenced lane WAS consulted, and each one
    // received the caller's scope — no lane call dropped the userId.
    const lanes = laneCalls.map((c) => c.lane).sort();
    expect(lanes).toEqual([
      'assistant',
      'digest',
      'episode',
      'excerpt',
      'grounding',
      'insight',
      'raw-window',
      'segment',
      'update-story',
    ]);
    expect(laneCalls.every((c) => c.userId === 'user-b')).toBe(true);
  });
});
