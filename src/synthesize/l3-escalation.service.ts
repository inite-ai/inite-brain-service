import { Injectable, Logger, Optional } from '@nestjs/common';
import type OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { chatCallParams } from '../ai/openai-client';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { traceArtifact } from '../common/debug-trace';
import { MetricsService } from '../metrics/metrics.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import type { SearchHit } from '../search/search.service';
import type { RetrievalProfile, LaneId } from '../search/retrieval-profile';
import { parseQueryTimeRange } from '../search/internals/time-range';
import type { SynthesizeDto } from './dto/synthesize.dto';
import { runVerifier, type VerifierOutput } from './verifier';
import { resolveCitations } from './synthesize.helpers';
import type { Citation } from './fact-index';
import type { GeneratorOutput } from './synthesize.types';
import {
  l3TriggerDecision,
  l3Covered,
  verifierPasses,
  rankL3Sessions,
  adaptiveL3SessionCount,
  estimateTokens,
  type L3SessionAnchor,
  type L3AdaptiveGate,
} from './l3-escalation';
import {
  buildFocusSignal,
  calibratedConfidence,
  queryClassOf,
  type PerClassCalibration,
} from './focus-signal';

/**
 * G2 L3 escalation lane (docs/roadmap/sota-gap-build-2026-08.md).
 *
 * The two escalation signals the literature validates hardest —
 * per-citation support verdicts (our judge-verifier) and answerability
 * self-assessment — already live in the stack and today terminate in
 * abstain/re-search. This service wires them UP one layer: on a
 * verifier-fail with an anchoring session, it lifts the top full raw
 * conversation transcripts (the context the extractor summarised away),
 * runs ONE large-context generation, re-runs the SAME verifier, and
 * returns the L3 answer only if the verdict flipped fail→pass.
 *
 * Loop-proof by construction: a monotone single-shot ladder (the
 * `escalated` guard in l3TriggerDecision, each tier entered at most
 * once) and an anchor requirement (no session named → abstain, never
 * burn a full-context call on empty memory). Bounded by
 * profile.l3MaxSessions and profile.l3TokenCap — over budget it
 * degrades to widened L2 raw-turn windows rather than truncating a
 * session mid-way. Every failure path returns null: the lane can only
 * ADD a flipped answer, never lose the normal abstention.
 */

/** Session sections + whether the budget forced the L2 degrade. */
interface L3Context {
  transcriptLines: string[];
  degraded: boolean;
}

/** Minimal turn shape shared by conversationTurns and windowAround rows. */
interface L3Turn {
  id?: unknown;
  speaker?: string;
  text: string;
  occurredAt: Date | string;
}

export interface L3EscalateInput {
  openai: OpenAI;
  model: string;
  companyId: string;
  dto: SynthesizeDto;
  callerScopes: string[];
  profile: RetrievalProfile;
  lane: LaneId | null;
  /** The fact-grounded answer's verifier verdict (the fail signal). */
  verdict: VerifierOutput;
  /** Whether the one search-loop refine round already ran this request. */
  refineAttempted: boolean;
  /** Monotone guard — a tier already escalated (normally false here). */
  escalated: boolean;
  results: SearchHit[];
  factIndex: Map<string, Citation>;
  /** The fact lines the verifier already saw (evidence parity). */
  factLines: string[];
  answerLang: string | null;
  dateMathLines?: string[] | undefined;
  /**
   * Optics-2 (§4.1) adaptive gate inputs, supplied by synthesize.service
   * ONLY when FOVEA_ADAPTIVE_L3 is on AND a usable per-class calibration
   * model is loaded for the tenant. Absent ⇒ the static coverage-floor
   * path runs (byte-identical to pre-Optics-2 L3). `calibration` is the
   * loaded per-class map; `threshold` the escalate cutoff on calibrated
   * confidence.
   */
  adaptiveL3?: { calibration: PerClassCalibration; threshold: number } | undefined;
}

/** A flipped L3 answer to finalise; null = fall through to abstention. */
export interface L3EscalateResult {
  verdict: VerifierOutput;
  answer: string;
  citations: Citation[];
}

const L3_SYSTEM = `You are an answer synthesizer with access to FULL raw conversation transcripts.

The extracted facts did not ground an answer, so you are given the complete raw sessions the relevant facts came from. Read the transcripts as the primary evidence and answer the user's query.
1. Use ONLY information present in the provided transcripts and facts. Do NOT speculate or use outside knowledge.
2. When a numbered fact supports a claim, inline its factId in square brackets EXACTLY as it appears (including the "knowledge_fact:" prefix) and mirror it into citedFactIds. Claims taken from the raw transcript need no citation.
3. If the transcripts do not answer the question, output the exact string "I don't have grounded evidence for that." with citedFactIds set to [].

Output strictly the JSON shape requested by the schema. No preamble, no chain-of-thought.`;

/** How much wider than the raw-window span the L2 degrade reaches when
 *  full sessions blow the token cap (still bounded, still fenced). */
const L3_DEGRADE_SPAN_MULT = 4;
/** Ceiling on episode ids resolved per escalation (bounds the IN set). */
const ANCHOR_EPISODE_CAP = 300;

@Injectable()
export class L3EscalationService {
  private readonly logger = new Logger(L3EscalationService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * The escalation entry point, called at the pre-abstention seam. Runs
   * the trigger matrix, and on 'fire' selects/fetches sessions,
   * generates once and re-verifies. Returns a flipped answer or null
   * (every non-flip and every failure falls through to abstention).
   */
  async escalate(input: L3EscalateInput): Promise<L3EscalateResult | null> {
    const { profile } = input;
    // Optics-2 (§4.1): resolve the adaptive confidence gate when the
    // service was handed a usable model; undefined ⇒ the static path.
    const adaptive = this.resolveAdaptiveGate(input);
    const reason = l3TriggerDecision({
      l3Escalation: profile.l3Escalation,
      verdict: input.verdict.verdict,
      questionAnswered: input.verdict.questionAnswered,
      covered: l3Covered(input.results, {
        minTopScore: profile.abstentionMinTopScore,
        minEvidence: profile.abstentionMinEvidence,
      }),
      refineAttempted: input.refineAttempted,
      searchLoop: profile.searchLoop,
      escalated: input.escalated,
      adaptive,
    });
    if (reason !== 'fire') return null;
    // Which sub-condition fired — the observability that tells the operator
    // whether the adaptive optic or the static floor is doing the gating.
    this.metrics?.countL3TriggerPath(adaptive ? 'adaptive' : 'static');
    try {
      return await this.runEscalation(input, adaptive);
    } catch (e) {
      // Fail-closed to abstention — the lane must never break synthesis.
      this.logger.warn(
        `L3 escalation failed (companyId=${input.companyId}): ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Optics-2 (§4.1) adaptive gate: build the focus signal from the same
   * per-fact scores + verdict the capture path uses, apply the loaded
   * per-class calibration, and return {confidence, threshold}. Returns
   * undefined when no model was supplied (adaptiveL3 absent) — the static
   * coverage path then runs. Also records the calibrated confidence on the
   * existing L3 ladder trace for observability. Pure math over pure
   * helpers (buildFocusSignal / calibratedConfidence); no IO.
   */
  private resolveAdaptiveGate(input: L3EscalateInput): L3AdaptiveGate | undefined {
    const a = input.adaptiveL3;
    if (!a) return undefined;
    const factScores: number[] = [];
    for (const hit of input.results) {
      for (const f of hit.facts) factScores.push(f.score);
    }
    const signal = buildFocusSignal({
      queryClass: queryClassOf(input.lane),
      factScores,
      verifierVerdict: input.verdict.verdict,
    });
    const confidence = calibratedConfidence(a.calibration, signal);
    traceArtifact('synthesize.l3_adaptive', {
      queryClass: signal.queryClass,
      confidence,
      threshold: a.threshold,
      coverageScore: signal.coverageScore,
      topScore: signal.topScore,
      retrievalGap: signal.retrievalGap,
    });
    return { confidence, threshold: a.threshold };
  }

  private async runEscalation(
    input: L3EscalateInput,
    adaptive?: L3AdaptiveGate,
  ): Promise<L3EscalateResult | null> {
    const { profile, dto } = input;
    const includePii = input.callerScopes.includes('brain:read_pii');
    const userId = dto.userId || undefined;
    const { anchors, episodeById } = await this.resolveAnchors(input, {
      includePii,
      userId,
    });
    if (anchors.length === 0) {
      this.metrics?.countL3Escalation('skipped_no_anchor');
      return null;
    }
    this.metrics?.countL3Escalation('fired');

    const window = input.lane === 'temporal' ? parseQueryTimeRange(dto.query) : null;
    // Optics-2 (§4.1) depth scaling: on the adaptive path #sessions scales
    // with the confidence deficit, BOUNDED by the static l3MaxSessions cap;
    // on the static path it IS l3MaxSessions (byte-identical). Never above
    // the cap either way — the token cap (assembleContext) is untouched.
    const maxSessions = adaptive
      ? adaptiveL3SessionCount({
          confidence: adaptive.confidence,
          threshold: adaptive.threshold,
          maxSessions: profile.l3MaxSessions,
        })
      : profile.l3MaxSessions;
    const sessionIds = rankL3Sessions(anchors, {
      max: maxSessions,
      window,
    });
    const ctx = await this.assembleContext(input, {
      sessionIds,
      episodeById,
      includePii,
      userId,
    });
    if (ctx.transcriptLines.length === 0) return null;
    if (ctx.degraded) this.metrics?.countL3Escalation('over_budget_degraded');

    const generated = await this.generate(input, ctx.transcriptLines);
    const citations = resolveCitations(generated.citedFactIds, generated.answer, input.factIndex);
    const verdict = await this.verify(input, generated.answer, ctx);
    if (!verifierPasses(verdict, profile.verifierTopicCoverage)) {
      this.metrics?.countL3Escalation('no_flip');
      return null;
    }
    this.metrics?.countL3Escalation('flipped');
    return { verdict, answer: generated.answer, citations };
  }

  /**
   * Resolve the retrieved facts' grounding stamps into anchoring
   * sessions — a targeted read of source.episodeIds for the ALREADY
   * selected fact ids (the episode-lane provenance idiom), then one
   * PII/user-fenced episode read to map episode→conversation. NOT a
   * re-retrieval: the SearchHit surface carries no episodeIds, so the
   * anchors come from the grounding stamps, fenced exactly like every
   * other L0 read (a hidden episode simply yields no anchor).
   */
  private async resolveAnchors(
    input: L3EscalateInput,
    fences: { includePii: boolean; userId?: string | undefined },
  ): Promise<{
    anchors: L3SessionAnchor[];
    episodeById: Map<string, { conversationId: string; atMs?: number | undefined }>;
  }> {
    const factScore = new Map<string, number>();
    for (const hit of input.results) {
      for (const f of hit.facts) {
        if (!factScore.has(f.factId)) factScore.set(f.factId, f.score ?? 0);
      }
    }
    const factIds = [...factScore.keys()];
    if (factIds.length === 0) return { anchors: [], episodeById: new Map() };

    const factEps = await this.surreal.withCompany(input.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id?: unknown; eps?: unknown }>]>(
        `SELECT id, source.episodeIds AS eps FROM knowledge_fact
            WHERE id INSIDE $ids AND source.episodeIds IS NOT NONE`,
        { ids: factIds.map((id) => new StringRecordId(id)) },
      );
      return rows ?? [];
    });
    // factId → its grounding episode ids, and the flat unique episode set.
    const epsByFact = new Map<string, string[]>();
    const allEpisodeIds = new Set<string>();
    for (const row of factEps) {
      const factId = String(row.id ?? '');
      if (!factId || !Array.isArray(row.eps)) continue;
      const eps = row.eps.map(String).filter((e) => e.startsWith('episode:'));
      if (eps.length === 0) continue;
      epsByFact.set(factId, eps);
      for (const e of eps) {
        if (allEpisodeIds.size < ANCHOR_EPISODE_CAP) allEpisodeIds.add(e);
      }
    }
    if (allEpisodeIds.size === 0) return { anchors: [], episodeById: new Map() };

    const episodeRows = await this.episodes.byIds({
      companyId: input.companyId,
      ids: [...allEpisodeIds],
      includePii: fences.includePii,
      ...(fences.userId !== undefined ? { userId: fences.userId } : {}),
    });
    const episodeById = new Map<string, { conversationId: string; atMs?: number | undefined }>();
    for (const r of episodeRows) {
      if (!r.conversationId) continue;
      episodeById.set(String(r.id), {
        conversationId: String(r.conversationId),
        atMs: toMs(r.occurredAt),
      });
    }
    // One anchor per (fact, conversation): a fact grounded in several
    // turns of one session still counts once toward that session's
    // density; a session hidden by the fences yields no anchor.
    const anchors: L3SessionAnchor[] = [];
    for (const [factId, eps] of epsByFact) {
      const seenConv = new Set<string>();
      for (const e of eps) {
        const ep = episodeById.get(e);
        if (!ep || seenConv.has(ep.conversationId)) continue;
        seenConv.add(ep.conversationId);
        anchors.push({
          conversationId: ep.conversationId,
          score: factScore.get(factId) ?? 0,
          atMs: ep.atMs,
        });
      }
    }
    return { anchors, episodeById };
  }

  /**
   * Fetch the selected full sessions and render them as fenced
   * transcript sections. When the assembled context exceeds the token
   * cap, degrade to widened L2 raw-turn windows around the anchor turns
   * of those sessions instead of truncating a session mid-way.
   */
  private async assembleContext(
    input: L3EscalateInput,
    args: {
      sessionIds: string[];
      episodeById: Map<string, { conversationId: string; atMs?: number | undefined }>;
      includePii: boolean;
      userId?: string | undefined;
    },
  ): Promise<L3Context> {
    const sessions = await Promise.all(
      args.sessionIds.map((conversationId) =>
        this.episodes
          .conversationTurns({
            companyId: input.companyId,
            conversationId,
            includePii: args.includePii,
            ...(args.userId !== undefined ? { userId: args.userId } : {}),
          })
          .then((turns) => ({ conversationId, turns })),
      ),
    );
    const full = this.renderSessions(sessions);
    if (estimateTokens(full.join('\n')) <= input.profile.l3TokenCap) {
      return { transcriptLines: full, degraded: false };
    }
    // Over budget: widen the L2 windows around the anchor turns of the
    // selected sessions (reuse windowAround) rather than truncating.
    const selected = new Set(args.sessionIds);
    const centers = [...args.episodeById.entries()].filter(([, v]) =>
      selected.has(v.conversationId),
    );
    const span = Math.max(1, input.profile.rawWindowSpan * L3_DEGRADE_SPAN_MULT);
    const windows = await Promise.all(
      centers.map(([, v]): Promise<L3Turn[]> =>
        v.atMs === undefined
          ? Promise.resolve([])
          : this.episodes.windowAround({
              companyId: input.companyId,
              conversationId: v.conversationId,
              centerIso: new Date(v.atMs).toISOString(),
              span,
              includePii: args.includePii,
              ...(args.userId !== undefined ? { userId: args.userId } : {}),
            }),
      ),
    );
    const byId = new Map<string, L3Turn>();
    for (const w of windows) {
      for (const row of w) {
        const key = String(row.id ?? `${String(row.occurredAt)}|${row.text}`);
        if (!byId.has(key)) byId.set(key, row);
      }
    }
    return {
      transcriptLines: this.renderSessions([
        { conversationId: 'windows', turns: [...byId.values()] },
      ]),
      degraded: true,
    };
  }

  /** One fenced section per session, chronological dated turns. */
  private renderSessions(sessions: Array<{ conversationId: string; turns: L3Turn[] }>): string[] {
    const lines: string[] = [];
    for (const s of sessions) {
      if (s.turns.length === 0) continue;
      lines.push(`--- session ${s.conversationId} ---`);
      const ordered = [...s.turns].sort(
        (a, b) => (toMs(a.occurredAt) ?? 0) - (toMs(b.occurredAt) ?? 0),
      );
      for (const t of ordered) {
        const day = String(
          t.occurredAt instanceof Date ? t.occurredAt.toISOString() : t.occurredAt,
        ).slice(0, 10);
        lines.push(`[${day}] ${t.speaker ?? 'unknown'}: ${t.text}`);
      }
    }
    return lines;
  }

  /** The ONE large-context generation. chatCallParams owns the token
   *  policy (reasoningCap for the large context); no hand-rolled params. */
  private async generate(
    input: L3EscalateInput,
    transcriptLines: string[],
  ): Promise<GeneratorOutput> {
    const sections = [
      `Full conversation transcripts:\n${transcriptLines.join('\n')}`,
      `Extracted facts (cite by factId when one supports a claim):\n${input.factLines.join('\n')}`,
    ];
    if (input.dateMathLines && input.dateMathLines.length > 0) {
      sections.push(`Computed date table:\n${input.dateMathLines.join('\n')}`);
    }
    const langLine = input.answerLang ? `\n\nAnswer in ${input.answerLang}.` : '';
    const user = `Query: ${input.dto.query}\n\n${sections.join('\n\n')}${langLine}`;
    traceArtifact('synthesize.l3_prompt', {
      system: L3_SYSTEM,
      user,
      model: input.model,
    });
    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.synthesize_l3',
        system: 'openai',
        model: input.model,
      },
      this.metrics,
      () =>
        input.openai.chat.completions.create(
          {
            model: input.model,
            messages: [
              { role: 'system', content: L3_SYSTEM },
              { role: 'user', content: user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'l3_answer',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    answer: { type: 'string' },
                    citedFactIds: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['answer', 'citedFactIds'],
                },
              },
            },
            // Large context → reasoningCap; chatCallParams centralises
            // the reasoning-model temperature/cap guard.
            ...chatCallParams(input.model, {
              temperature: 0,
              visibleCap: 1024,
              reasoningCap: 8192,
            }),
          },
          { signal: getAbortSignal() },
        ),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty L3 generator response');
    const parsed = JSON.parse(content) as GeneratorOutput;
    if (typeof parsed.answer !== 'string') {
      throw new Error('L3 generator returned non-string answer');
    }
    if (!Array.isArray(parsed.citedFactIds)) parsed.citedFactIds = [];
    traceArtifact('synthesize.l3_output', parsed);
    return parsed;
  }

  /** Re-run the SAME verifier over the L3 answer against the session
   *  transcripts (the evidence the L3 generator was given). */
  private async verify(
    input: L3EscalateInput,
    answer: string,
    ctx: L3Context,
  ): Promise<VerifierOutput> {
    return runVerifier({
      openai: input.openai,
      metrics: this.metrics,
      query: input.dto.query,
      answer,
      factLines: input.factLines,
      transcriptLines: ctx.transcriptLines,
      topicCoverage: input.profile.verifierTopicCoverage,
      dateMathLines: input.dateMathLines,
      model: input.profile.verifierModel || input.model,
    });
  }
}

function toMs(v: Date | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
}
