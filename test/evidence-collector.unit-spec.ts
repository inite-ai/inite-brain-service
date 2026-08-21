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
