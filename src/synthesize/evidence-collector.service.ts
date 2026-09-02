import { Injectable, Logger, Optional } from '@nestjs/common';
import { SearchService, SearchHit } from '../search/search.service';
import type { LaneId, RetrievalProfile } from '../search/retrieval-profile';
import type { SearchDto } from '../search/dto/search.dto';
import { getAbortSignal } from '../common/request-context';
import { withSpan } from '../common/tracing';
import { INSTRUCTION_PROBE_QUERY, extractStandingInstructions } from './answer-router';
import { buildSecondaryDto } from './synthesize.helpers';
import {
  wantsInsightEvidence,
  wantsTimelineEvidence,
  wantsVerbatimEvidence,
} from './evidence-gates';
import { CrossEncoderService } from '../ai/cross-encoder.service';
import { StrategyMemoryService, renderStrategyNote } from '../strategy/strategy-memory.service';
import { EpisodeLaneService } from './episode-lane.service';
import { SegmentLaneService } from './segment-lane.service';
import { InsightLaneService } from './insight-lane.service';
import { MentionScanService } from './mention-scan.service';
import { QueryArcService } from './query-arc.service';
import { UpdateStoryService } from './update-story.service';
import { DigestLaneService } from './digest-lane.service';
import { FragmentLaneService } from './fragment-lane.service';
import type { CitableFragment } from './fragment-citations';
import type { CoverageScanTuning } from './scan-leg';

/** Grounding anchors the raw-window lane expands (top evidence order). */
const RAW_WINDOW_MAX_ANCHORS = 4;

/** Hard bound on assistant-lane quotes regardless of env/override
 *  (audit 2026-08-21 #7): with the 600-char line cap this bounds the
 *  section at ~14K chars even under a hostile override. */
const ASSISTANT_LANE_MAX_TOPK = 24;

/** V13 noise filter: sections at or under this length pass untouched —
 *  filtering a short section risks more than it saves. */
const NOISE_FILTER_MIN_LINES = 8;
/** Fraction of a filtered section's lines that survives (top-ranked). */
const NOISE_FILTER_KEEP_FRACTION = 0.6;

/** Dense-leg tuning of the coverage scan lanes, from the profile. */
function scanTuning(profile: RetrievalProfile): CoverageScanTuning {
  return {
    mode: profile.coverageScanMode,
    ef: profile.scanHnswEf,
    overfetch: profile.scanHnswOverfetch,
  };
}

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
  instructions?: string[] | undefined;
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
  updateStories?: Map<string, string> | undefined;
  /**
   * Multiworld §10 facts-as-keys: factId → rendered grounding quote
   * (" [source YYYY-MM-DD speaker: …]") for the top evidence facts;
   * undefined when the profile has the lane off or nothing resolves.
   * Applied by the caller to the SAME fact lines both prompts read —
   * exactly the updateStories contract.
   */
  groundingQuotes?: Map<string, string> | undefined;
  /**
   * MM-zoom PR2 fragment lane (profile.fragmentLane): rendered media-
   * evidence lines — `[capability:<kind>]`-tagged derived-representation
   * excerpts of 0109 media observations — the prompt's OWN media
   * section. Evidence parity by construction: the generator renders them
   * as a section and the verifier reads the SAME lines as
   * capabilityEvidenceLines. Deliberately NOT noise-filtered (bounded at
   * 4 lines by the lane; a relevance cut on so small a section risks
   * more than it saves). Empty when the lane is off / unwired / fenced
   * out (consent, PII, availability) / failed.
   */
  fragmentLines: string[];
  /**
   * The rendered-set citation fence for resolveFragmentCitations
   * (EVIDENCE_FRAGMENT_CITATIONS): fragmentId → rendered-fragment info
   * for EXACTLY the fragments in fragmentLines. undefined when the
   * citations flag was off for this request (no headers rendered,
   * nothing citable) or the lane produced nothing.
   */
  fragmentsById?: ReadonlyMap<string, CitableFragment> | undefined;
  /**
   * G4 strategy lane: rendered advisory notes (k≤2, default 1) from
   * the separate strategy_memory store; undefined when the lane is off
   * the profile or read-side serving is disabled.
   *
   * DELIBERATE EXCEPTION to the evidence-parity invariant (audit W5
   * #22 — "whatever the generator sees the verifier must see"): these
   * notes go to the GENERATOR only, in a fenced ADVISORY section, and
   * are NEVER handed to the verifier as evidence. They are advice
   * about HOW to answer, not support for WHAT is answered — presenting
   * them as evidence would let an unsupported claim verify as
   * supported just because a strategy note mentioned its topic. The
   * parity invariant covers evidence; advisory guidance is not
   * evidence. (Mirrored in verifier.ts where the invariant is
   * documented.)
   */
  strategyNotes?: string[] | undefined;
}

/**
 * Collector-absent fallback (unit fixtures, trimmed deployments): empty
 * sections; only the timeline gate is still computed, exactly as the
 * collector would. Lives beside CollectedEvidence so a new section
 * cannot be added without the fallback seeing it (the orchestrator
 * imports this instead of hand-rolling the empty shape).
 */
export function emptyCollectedEvidence(
  profile: RetrievalProfile,
  query: string,
): CollectedEvidence {
  return {
    transcriptLines: [],
    insightLines: [],
    instructions: undefined,
    timelineEvidence: wantsTimelineEvidence(profile, query),
    updateStories: undefined,
    groundingQuotes: undefined,
    strategyNotes: undefined,
    fragmentLines: [],
    fragmentsById: undefined,
  };
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
    @Optional() private readonly digestLane?: DigestLaneService,
    @Optional() private readonly crossEncoder?: CrossEncoderService,
    @Optional() private readonly strategyMemory?: StrategyMemoryService,
    @Optional() private readonly fragmentLane?: FragmentLaneService,
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
    userId?: string | undefined;
    /** The caller's full request — secondary searches (instruction
     *  probe) inherit its filter contract (audit 2026-08-19 P1). */
    dto?: SearchDto;
    factIds: string[];
    evidence: SearchHit[];
    /** EVIDENCE_FRAGMENT_CITATIONS, resolved ONCE by the caller (the L3
     *  single-resolution idiom) — this service reads no env. */
    fragmentCitations?: boolean | undefined;
  }): Promise<CollectedEvidence> {
    const { profile, query } = opts;
    const timelineEvidence = wantsTimelineEvidence(profile, query);
    const [
      instructions,
      transcriptLines,
      insightLines,
      updateStories,
      digestLines,
      groundingQuotes,
      strategyNotes,
      fragmentEvidence,
    ] = await Promise.all([
      this.collectStandingInstructions(opts),
      this.collectTranscriptLines(opts, timelineEvidence),
      this.collectInsightLines(opts),
      this.collectUpdateStories(opts),
      this.collectDigestLines(opts),
      this.collectGroundingQuotes(opts),
      this.collectStrategyNotes(opts),
      this.collectFragmentEvidence(opts),
    ]);
    // V12 §2: digests merge AHEAD of retrieved insight lines under
    // the same slot — generator, verifier and NLI judge all see them
    // (evidence parity by construction, the W5 #22 lesson).
    const insightSlot = digestLines.length ? [...digestLines, ...insightLines] : insightLines;
    // V13 noise filter (the unported LIGHT component): injected
    // context sections are relevance-gated by the local cross-encoder;
    // fact lines are NEVER filtered. The mention record is exempt —
    // its value is coverage, exactly what a relevance cut destroys.
    const [filteredTranscript, filteredInsights] =
      profile.noiseFilter && this.crossEncoder?.isEnabled()
        ? await Promise.all([
            timelineEvidence ? transcriptLines : this.noiseFilterLines(query, transcriptLines),
            this.noiseFilterLines(query, insightSlot),
          ])
        : [transcriptLines, insightSlot];
    return {
      transcriptLines: filteredTranscript,
      insightLines: filteredInsights,
      instructions,
      timelineEvidence,
      updateStories,
      groundingQuotes,
      strategyNotes,
      fragmentLines: fragmentEvidence.lines,
      fragmentsById: fragmentEvidence.byId.size > 0 ? fragmentEvidence.byId : undefined,
    };
  }

  /**
   * MM-zoom PR2 fragment lane — gated on profile.fragmentLane; degrades
   * to an empty section on absence/abort (the lane owns its own error
   * degrade). The citations switch arrives resolved from the caller
   * (EVIDENCE_FRAGMENT_CITATIONS — no env read here).
   */
  private async collectFragmentEvidence({
    profile,
    companyId,
    query,
    callerScopes,
    userId,
    fragmentCitations,
  }: {
    profile: RetrievalProfile;
    companyId: string;
    query: string;
    callerScopes: string[];
    userId?: string | undefined;
    fragmentCitations?: boolean | undefined;
  }): Promise<{ lines: string[]; byId: ReadonlyMap<string, CitableFragment> }> {
    const empty = { lines: [], byId: new Map<string, CitableFragment>() };
    if (!profile.fragmentLane || !this.fragmentLane) return empty;
    if (getAbortSignal()?.aborted) return empty;
    return this.fragmentLane.fragmentLines({
      companyId,
      query,
      callerScopes,
      userId,
      withIds: fragmentCitations === true,
    });
  }

  /**
   * G4 strategy lane — gated on profile lane membership AND the
   * service's own read-side flag (this service reads no env; the
   * flags live behind StrategyMemoryService, which returns [] when
   * serving is off). Advisory-only output: see the strategyNotes
   * parity-exception note on CollectedEvidence. Degrades to undefined
   * on any failure — advice must never fail an answer.
   */
  private async collectStrategyNotes({
    profile,
    companyId,
    query,
  }: {
    profile: RetrievalProfile;
    companyId: string;
    query: string;
  }): Promise<string[] | undefined> {
    if (!profile.lanes.has('strategy') || !this.strategyMemory) {
      return undefined;
    }
    if (!this.strategyMemory.isRetrievalEnabled()) return undefined;
    if (getAbortSignal()?.aborted) return undefined;
    try {
      const items = await withSpan('synthesize.strategy_notes', () =>
        this.strategyMemory!.retrieve(companyId, query),
      );
      if (items.length === 0) return undefined;
      return items.map(renderStrategyNote);
    } catch (e) {
      this.logger.warn(`strategy notes failed (companyId=${companyId}): ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Multiworld §10 facts-as-keys — gated on profile.factsAsKeys;
   * degrades to undefined. Cap applies to the BEST evidence facts
   * (factIds arrive in evidence order).
   */
  private async collectGroundingQuotes({
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
    userId?: string | undefined;
  }): Promise<Map<string, string> | undefined> {
    if (!profile.factsAsKeys || !this.episodeLane) return undefined;
    if (factIds.length === 0) return undefined;
    if (getAbortSignal()?.aborted) return undefined;
    const quotes = await this.episodeLane.groundingQuotes({
      companyId,
      factIds: factIds.slice(0, profile.factsAsKeysCap),
      callerScopes,
      userId,
    });
    return quotes.size > 0 ? quotes : undefined;
  }

  /**
   * Keep the top-ranked NOISE_FILTER_KEEP_FRACTION of a section's
   * lines (cross-encoder relevance vs the query), preserving the
   * section's original order. Two inert paths: short sections pass
   * untouched, and an exact-identity permutation reads as "no ranking
   * signal" (the provider's failure fallback) — everything survives.
   */
  private async noiseFilterLines(query: string, lines: string[]): Promise<string[]> {
    if (lines.length <= NOISE_FILTER_MIN_LINES || !this.crossEncoder) {
      return lines;
    }
    const perm = await this.crossEncoder.rerank(
      query,
      lines.map((l) => ({ label: l, body: '' })),
    );
    if (perm.every((p, i) => p === i)) return lines;
    const keepCount = Math.max(
      NOISE_FILTER_MIN_LINES,
      Math.ceil(lines.length * NOISE_FILTER_KEEP_FRACTION),
    );
    const keep = new Set(perm.slice(0, keepCount));
    return lines.filter((_, i) => keep.has(i));
  }

  /** V12 §2 read side — gated on profile.digestEvidence; degrades [].
   *  V13 gate-shaping: under digestLanes='summary_ku' the narrative
   *  block renders only for summary/recency-routed questions (the
   *  lanes that took the measured strict gains) — everywhere else it
   *  measurably bleeds (abstention −7.5, summarization nugget −1.9). */
  private async collectDigestLines(opts: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    companyId: string;
    userId?: string | undefined;
  }): Promise<string[]> {
    if (!opts.profile.digestEvidence || !this.digestLane) return [];
    if (
      opts.profile.digestLanes === 'summary_ku' &&
      opts.lane !== 'summary' &&
      opts.lane !== 'recency'
    ) {
      return [];
    }
    if (getAbortSignal()?.aborted) return [];
    // Audit 2026-08-19 P1 → 0087: digests now carry per-user policy
    // metadata (userScopes) — the lane applies the fail-closed policy
    // in SQL, so a user-scoped request reads only purely tenant-global
    // digests and its own single-user digests.
    return this.digestLane
      .digestLines({ companyId: opts.companyId, userId: opts.userId })
      .then((v) => v ?? []);
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
    userId?: string | undefined;
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
      userId?: string | undefined;
    },
    timelineActive: boolean,
  ): Promise<string[]> {
    const active = wantsVerbatimEvidence(profile, query);
    if (getAbortSignal()?.aborted) return [];
    // V9 §2: under timelineEvidence='scan' the ordering dispatch is
    // served by the mention-scan lane (coverage-first, one line per
    // session) INSTEAD of the top-K segment appendix — the appendix
    // still runs for the 'always' verbatim profile and for 'routed'.
    const scanActive = timelineActive && profile.timelineEvidence === 'scan' && !!this.mentionScan;
    // The lanes are independent reads — run them concurrently
    // (audit W4 carried: they used to be sequential awaits).
    // Segments compete for the prompt on their own retrieval merit —
    // an 'always' verbatim profile runs them; the shape-conditioned
    // default does not (they measurably distract on assistant chats);
    // 'fused' retrieves them as scored SearchHits inside search, so
    // appending them here would duplicate the evidence.
    const [
      laneLines = [],
      sourceLines = [],
      segmentLines = [],
      scanLines = [],
      windowLines = [],
      assistantLines = [],
    ] = await Promise.all([
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
              scan: scanTuning(profile),
              lex: profile.coverageLexMode,
              segmentCjk: profile.cjkSegmentation,
            })
            .then((v) => v ?? [])
        : [],
      // V13 raw-window lane: gated on its OWN flag, not the verbatim
      // mode — the hybrid-substrate leg must be measurable on the
      // default shape-conditioned profile.
      profile.rawWindow
        ? this.episodeLane
            ?.rawWindows({
              companyId,
              factIds,
              callerScopes,
              userId,
              anchors: RAW_WINDOW_MAX_ANCHORS,
              span: profile.rawWindowSpan,
            })
            .then((v) => v ?? [])
        : [],
      // Multiworld §10 assistant lane: role-filtered verbatim over
      // L0 — same own-flag gating as raw-window, measurable on the
      // default profile.
      profile.assistantLane
        ? this.episodeLane
            ?.assistantTurns({
              companyId,
              query,
              callerScopes,
              userId,
              limit: Math.min(profile.assistantLaneTopK, ASSISTANT_LANE_MAX_TOPK),
              match: profile.assistantLaneMatch,
            })
            .then((v) => v ?? [])
        : [],
    ]).then((lanes) => lanes.map((l) => l ?? []));
    return [
      ...new Set([
        ...scanLines,
        ...assistantLines,
        ...windowLines,
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
    userId?: string | undefined;
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
        .arcLines({
          companyId,
          query,
          callerScopes,
          userId,
          scan: scanTuning(profile),
          lex: profile.coverageLexMode,
        })
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
    dto,
  }: {
    profile: RetrievalProfile;
    companyId: string;
    callerScopes: string[];
    evidence: SearchHit[];
    dto?: SearchDto;
  }): Promise<string[] | undefined> {
    if (!profile.lanes.has('instruction')) return undefined;
    // Structured cancellation: the probe is a full second search — if
    // the request already died, don't spend it. (Per-query aborts are
    // not supported by the DB SDK; stage-boundary checks are the
    // honest granularity.)
    if (getAbortSignal()?.aborted) return undefined;
    let probeHits: SearchHit[] = [];
    try {
      // Audit 2026-08-19 P1: the probe inherits the caller's filter
      // contract (user scope included) — only its query/limit are fixed.
      const probe = await withSpan('synthesize.instruction_probe', () =>
        this.search.search(
          companyId,
          dto
            ? buildSecondaryDto(dto, { query: INSTRUCTION_PROBE_QUERY, limit: 8 })
            : ({ query: INSTRUCTION_PROBE_QUERY, limit: 8 } as SearchDto),
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
