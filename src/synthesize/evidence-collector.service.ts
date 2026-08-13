import { Injectable, Logger, Optional } from '@nestjs/common';
import { SearchService, SearchHit } from '../search/search.service';
import type { LaneId, RetrievalProfile } from '../search/retrieval-profile';
import type { SearchDto } from '../search/dto/search.dto';
import { getAbortSignal } from '../common/request-context';
import { withSpan } from '../common/tracing';
import {
  INSTRUCTION_PROBE_QUERY,
  extractStandingInstructions,
} from './answer-router';
import {
  wantsInsightEvidence,
  wantsTimelineEvidence,
  wantsVerbatimEvidence,
} from './evidence-gates';
import { EpisodeLaneService } from './episode-lane.service';
import { SegmentLaneService } from './segment-lane.service';
import { InsightLaneService } from './insight-lane.service';
import { MentionScanService } from './mention-scan.service';
import { QueryArcService } from './query-arc.service';
import { UpdateStoryService } from './update-story.service';

/**
 * EvidenceCollectorService — the one owner of every typed prompt
 * section BEYOND the fact lines: verbatim transcript quotes (episode /
 * provenance / segment / mention-scan lanes), derived insights, and
 * standing instructions. Split out of SynthesizeService in the V9
 * quality pass: the orchestrator kept accreting lane services (four
 * @Optional deps by V9) and their gating; now it depends on ONE
 * collector behind one contract, and adding an evidence lane touches
 * this module only.
 *
 * Contracts preserved from the original methods verbatim:
 *   - every lane degrades to an empty section, never fails the answer;
 *   - abort checks at stage boundaries (per-query aborts are not
 *     supported by the DB SDK);
 *   - all lanes run concurrently (audit W4 carried);
 *   - activation comes from the resolved profile via the pure
 *     evidence-gates module — this service reads no env.
 */

export interface CollectedEvidence {
  /** Deduped verbatim lines for the transcript section. */
  transcriptLines: string[];
  /** Derived-insight lines (V8 §1), own budget slot. */
  insightLines: string[];
  /** T7 standing instructions; undefined = section omitted. */
  instructions?: string[];
  /**
   * V8 §2 / V9 §2: the transcript section is the MENTION RECORD for
   * this query — computed once here so the generator and verifier
   * framings can never disagree.
   */
  timelineEvidence: boolean;
  /**
   * V10 §2: factId → rendered history suffix ("previously: … — until
   * …") for evidence facts that superseded an older value; undefined
   * when the profile has the lane off or nothing has history. Applied
   * by the caller to the SAME fact lines both prompts read.
   */
  updateStories?: Map<string, string>;
}

@Injectable()
export class EvidenceCollectorService {
  private readonly logger = new Logger(EvidenceCollectorService.name);

  // Lane fan-in is this service's whole job; @Optional so partial
  // wiring (unit fixtures, trimmed deployments) degrades to empty
  // sections instead of failing DI.
  // eslint-disable-next-line max-params
  constructor(
    private readonly search: SearchService,
    @Optional() private readonly episodeLane?: EpisodeLaneService,
    @Optional() private readonly segmentLane?: SegmentLaneService,
    @Optional() private readonly insightLane?: InsightLaneService,
    @Optional() private readonly mentionScan?: MentionScanService,
    @Optional() private readonly queryArc?: QueryArcService,
    @Optional() private readonly updateStory?: UpdateStoryService,
  ) {}

  /**
   * Collect every non-fact prompt section for one answer, concurrently.
   * `evidence` is the post-union hit set (instructions merge over it);
   * `factIds` are the selected citation targets (provenance excerpts).
   */
  async collect(opts: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    companyId: string;
    query: string;
    callerScopes: string[];
    userId?: string;
    factIds: string[];
    evidence: SearchHit[];
  }): Promise<CollectedEvidence> {
    const { profile, query } = opts;
    const timelineEvidence = wantsTimelineEvidence(profile, query);
    const [instructions, transcriptLines, insightLines, updateStories] =
      await Promise.all([
        this.collectStandingInstructions(opts),
        this.collectTranscriptLines(opts, timelineEvidence),
        this.collectInsightLines(opts),
        this.collectUpdateStories(opts),
      ]);
    return {
      transcriptLines,
      insightLines,
      instructions,
      timelineEvidence,
      updateStories,
    };
  }

  /**
   * V10 §2: the history suffixes for evidence facts that superseded an
   * older value. Gated on the profile; degrades to undefined.
   */
  private async collectUpdateStories({
    profile,
    companyId,
    callerScopes,
    factIds,
    userId,
  }: {
    profile: RetrievalProfile;
    companyId: string;
    callerScopes: string[];
    factIds: string[];
    userId?: string;
  }): Promise<Map<string, string> | undefined> {
    if (!profile.updateStoryRendering || !this.updateStory) return undefined;
    if (factIds.length === 0) return undefined;
    if (getAbortSignal()?.aborted) return undefined;
    return this.updateStory.previousStories({
      companyId,
      factIds,
      callerScopes,
      userId,
    });
  }

  /**
   * Verbatim L0 quotes, one deduped section from four flag-gated lanes:
   * episodic BM25 (P2) — question-driven turn quotes; provenance
   * excerpts (A1) — source turns of the selected evidence facts;
   * segment lane (R1) — multi-turn segments retrieved on their own
   * dense+BM25 merit; mention-scan (V9 §2) — the coverage-first
   * session-mention record for ordering questions.
   */
  private async collectTranscriptLines(
    {
      profile,
      companyId,
      query,
      callerScopes,
      factIds,
      userId,
    }: {
      profile: RetrievalProfile;
      companyId: string;
      query: string;
      callerScopes: string[];
      factIds: string[];
      userId?: string;
    },
    timelineActive: boolean,
  ): Promise<string[]> {
    const active = wantsVerbatimEvidence(profile, query);
    if (getAbortSignal()?.aborted) return [];
    // V9 §2: under timelineEvidence='scan' the ordering dispatch is
    // served by the mention-scan lane (coverage-first, one line per
    // session) INSTEAD of the top-K segment appendix — the appendix
    // still runs for the 'always' verbatim profile and for 'routed'.
    const scanActive =
      timelineActive &&
      profile.timelineEvidence === 'scan' &&
      !!this.mentionScan;
    // The lanes are independent reads — run them concurrently
    // (audit W4 carried: they used to be sequential awaits).
    // Segments compete for the prompt on their own retrieval merit —
    // an 'always' verbatim profile runs them; the shape-conditioned
    // default does not (they measurably distract on assistant chats);
    // 'fused' retrieves them as scored SearchHits inside search, so
    // appending them here would duplicate the evidence.
    const [laneLines, sourceLines, segmentLines, scanLines] =
      await Promise.all([
        active
          ? this.episodeLane
              ?.transcriptLines({
                companyId,
                query,
                callerScopes,
                userId,
                limit: profile.quotesPerPrompt,
              })
              .then((v) => v ?? [])
          : [],
        active
          ? this.episodeLane
              ?.sourceExcerpts({
                companyId,
                factIds,
                callerScopes,
                userId,
                cap: profile.sourceExcerptsCap,
              })
              .then((v) => v ?? [])
          : [],
        profile.verbatimEvidence === 'always' || (timelineActive && !scanActive)
          ? this.segmentLane
              ?.transcriptLines({
                companyId,
                query,
                callerScopes,
                userId,
                topK: profile.segmentTopK,
                rerank: profile.segmentRerank,
              })
              .then((v) => v ?? [])
          : [],
        scanActive
          ? this.mentionScan
              ?.mentionLines({
                companyId,
                query,
                callerScopes,
                userId,
                // V10 §3: the ordering frame asks for distinct aspect
                // items, so repeats collapse at the record level too.
                dedupeAspects: profile.orderingFrame,
              })
              .then((v) => v ?? [])
          : [],
      ]).then((lanes) => lanes.map((l) => l ?? []));
    return [
      ...new Set([
        ...scanLines,
        ...segmentLines,
        ...sourceLines,
        ...laneLines,
      ]),
    ];
  }

  /**
   * V8 §1: derived insights (aggregates + summaries) for the prompt's
   * dedicated section. Gated on wantsInsightEvidence; degrades to [].
   */
  private async collectInsightLines(opts: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    companyId: string;
    query: string;
    callerScopes: string[];
    userId?: string;
  }): Promise<string[]> {
    const { profile, lane, companyId, query, callerScopes, userId } = opts;
    if (!wantsInsightEvidence(profile, lane)) return [];
    if (getAbortSignal()?.aborted) return [];
    // V10 §4: under 'query_arc' the slot is assembled at read time
    // from the atomic fact record instead of retrieved from stored
    // insight rows.
    if (profile.insightEvidence === 'query_arc') {
      if (!this.queryArc) return [];
      return this.queryArc
        .arcLines({ companyId, query, callerScopes, userId })
        .then((v) => v ?? []);
    }
    if (!this.insightLane) return [];
    return this.insightLane
      .insightLines({ companyId, query, callerScopes, userId })
      .then((v) => v ?? []);
  }

  /**
   * T7: standing user instructions for the prompt's dedicated section.
   * UNCONDITIONAL (IF questions are deliberately neutral — no lexical
   * route can fire): a fixed probe pulls instruction-shaped facts,
   * merged with any already in the evidence. undefined when the lane is
   * off or nothing qualifies; probe failures degrade to evidence-only.
   */
  private async collectStandingInstructions({
    profile,
    companyId,
    callerScopes,
    evidence,
  }: {
    profile: RetrievalProfile;
    companyId: string;
    callerScopes: string[];
    evidence: SearchHit[];
  }): Promise<string[] | undefined> {
    if (!profile.lanes.has('instruction')) return undefined;
    // Structured cancellation: the probe is a full second search — if
    // the request already died, don't spend it. (Per-query aborts are
    // not supported by the DB SDK; stage-boundary checks are the
    // honest granularity.)
    if (getAbortSignal()?.aborted) return undefined;
    let probeHits: SearchHit[] = [];
    try {
      const probe = await withSpan('synthesize.instruction_probe', () =>
        this.search.search(
          companyId,
          { query: INSTRUCTION_PROBE_QUERY, limit: 8 } as SearchDto,
          callerScopes,
        ),
      );
      probeHits = probe.results;
    } catch (e) {
      this.logger.warn(
        `instruction probe failed (companyId=${companyId}): ${(e as Error).message}`,
      );
    }
    const list = extractStandingInstructions([...evidence, ...probeHits]);
    return list.length > 0 ? list : undefined;
  }
}
