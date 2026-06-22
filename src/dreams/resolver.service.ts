import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';

/**
 * DreamsResolverService — auto-resolve competing fact pairs that
 * have aged past a threshold without human action.
 *
 * Brain's conflict resolver writes facts to status='competing' when
 * two contradicting facts arrive at near-identical confidence (the
 * margin gate doesn't fire). That status keeps both visible to
 * search by design — the operator decides which is true. But pairs
 * that linger for weeks usually mean the operator forgot, not that
 * the data is genuinely ambiguous. This service finds those, asks
 * an LLM to pick the winner using surrounding context, and either:
 *   - marks the loser as superseded with reason='dreams_resolution', or
 *   - leaves both alone and logs an unsure verdict for ops.
 *
 * Bounded by DREAMS_RESOLVE_MAX_PAIRS per run. Min-age gate
 * (DREAMS_RESOLVE_MIN_AGE_DAYS) means freshly created competing
 * pairs aren't auto-resolved before the operator can.
 *
 * Failure modes are explicit. LLM outage on a pair → log + continue.
 * The optimistic update keeps the loser fact intact on any DB error
 * — there is no "partial state" branch.
 */
export interface ResolverResolution {
  winnerFactId: string;
  loserFactId: string;
  predicate: string;
  entityId: string;
  winnerObject: string;
  loserObject: string;
}

export interface ResolverResult {
  pairsConsidered: number;
  llmJudgements: number;
  resolutionsApplied: number;
  unsurePairs: number;
  /** Per-resolution detail for the admin UI drill-down. */
  resolutions: ResolverResolution[];
}

interface CompetingFactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  recordedAt: string;
  source: unknown;
}

@Injectable()
export class DreamsResolverService {
  private readonly logger = new Logger(DreamsResolverService.name);
  private readonly openai: OpenAI;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly minAgeDays: number;
  private readonly maxPairs: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_RESOLVE_ENABLED', '0') === '1';
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey
      ? new OpenAI({
          apiKey,
          timeout: parseInt(
            this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
            10,
          ),
          maxRetries: parseInt(
            this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
            10,
          ),
        })
      : (undefined as unknown as OpenAI);
    this.model = this.configService.get<string>(
      'DREAMS_RESOLVE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.minAgeDays = parseInt(
      this.configService.get<string>('DREAMS_RESOLVE_MIN_AGE_DAYS', '7'),
      10,
    );
    this.maxPairs = parseInt(
      this.configService.get<string>('DREAMS_RESOLVE_MAX_PAIRS', '20'),
      10,
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('DREAMS_RESOLVE_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  async run(db: Surreal): Promise<ResolverResult> {
    const result: ResolverResult = {
      pairsConsidered: 0,
      llmJudgements: 0,
      resolutionsApplied: 0,
      unsurePairs: 0,
      resolutions: [],
    };
    if (!this.isEnabled()) return result;

    const pairs = await withSpan(
      'dreams.resolve.find_pairs',
      () => this.findCompetingPairs(db),
      { 'resolve.min_age_days': this.minAgeDays },
    );
    result.pairsConsidered = pairs.length;
    if (pairs.length === 0) return result;

    for (const pair of pairs) {
      const verdict = await withSpan(
        'dreams.resolve.judge',
        () => this.limiter.run(() => this.judge(db, pair)),
      );
      result.llmJudgements++;
      if (verdict.kind === 'unsure') {
        result.unsurePairs++;
        this.logger.warn(
          `[dreams.resolve] unsure: entity=${String(pair.a.entityId)} predicate=${pair.a.predicate} a='${pair.a.object}' vs b='${pair.b.object}'`,
        );
        continue;
      }
      const loserId = verdict.kind === 'a_wins' ? String(pair.b.id) : String(pair.a.id);
      const winnerId = verdict.kind === 'a_wins' ? String(pair.a.id) : String(pair.b.id);
      const winner = verdict.kind === 'a_wins' ? pair.a : pair.b;
      const loser = verdict.kind === 'a_wins' ? pair.b : pair.a;
      await this.markSuperseded(db, loserId, winnerId);
      result.resolutionsApplied++;
      result.resolutions.push({
        winnerFactId: winnerId,
        loserFactId: loserId,
        predicate: winner.predicate,
        entityId: String(winner.entityId),
        winnerObject: winner.object,
        loserObject: loser.object,
      });
    }

    return result;
  }

  /**
   * Find competing fact pairs aged past the min-age gate. Group by
   * (entityId, predicate); only return pairs (exactly 2 per group).
   * If a group has 3+ competing facts, skip — that's a multi-way
   * disagreement that needs operator attention, not auto-resolution.
   */
  private async findCompetingPairs(
    db: Surreal,
  ): Promise<Array<{ a: CompetingFactRow; b: CompetingFactRow }>> {
    const cutoff = new Date(
      Date.now() - this.minAgeDays * 24 * 60 * 60 * 1000,
    );
    const [rows] = await db.query<[CompetingFactRow[]]>(
      `SELECT id, entityId, predicate, object, confidence, validFrom, recordedAt, source
       FROM knowledge_fact
       WHERE status = 'competing'
         AND retractedAt IS NONE
         AND recordedAt <= $cutoff
       ORDER BY entityId, predicate, recordedAt ASC`,
      { cutoff },
    );
    const all = (rows as CompetingFactRow[]) ?? [];

    // Group by (entityId, predicate).
    const byKey = new Map<string, CompetingFactRow[]>();
    for (const r of all) {
      const key = `${String(r.entityId)}::${r.predicate}`;
      const arr = byKey.get(key);
      if (arr) arr.push(r);
      else byKey.set(key, [r]);
    }

    const pairs: Array<{ a: CompetingFactRow; b: CompetingFactRow }> = [];
    for (const group of byKey.values()) {
      if (group.length !== 2) continue;
      pairs.push({ a: group[0], b: group[1] });
      if (pairs.length >= this.maxPairs) break;
    }
    return pairs;
  }

  /**
   * Ask the LLM which fact in a competing pair is more likely true.
   * Verdict ∈ {a_wins, b_wins, unsure}. The strict-schema response
   * carries a one-sentence rationale we log on resolution apply for
   * audit, but never persist server-side.
   */
  private async judge(
    db: Surreal,
    pair: { a: CompetingFactRow; b: CompetingFactRow },
  ): Promise<{ kind: 'a_wins' | 'b_wins' | 'unsure' }> {
    // Pull a few neighbouring active facts on the same entity to give
    // the LLM context — sometimes the resolution depends on what's
    // around the conflict (e.g. status: active vs churned, where a
    // recent payment fact tilts toward "active").
    const ctxFacts = await this.fetchEntityContext(
      db,
      String(pair.a.entityId),
    );
    const sys = `You resolve a CONTRADICTION between two facts in a knowledge graph.

Both facts share the same entity and the same predicate but disagree on the object value (e.g. status=active vs status=churned). Decide which is more likely TRUE based on:
- recency (newer fact > older when there's no other signal)
- source trust (human_declared > inbox_extraction > voice_transcript)
- coherence with surrounding context facts about the same entity

Verdict:
- "a_wins": fact A is more likely true; fact B should be marked superseded
- "b_wins": vice versa
- "unsure": evidence does not disambiguate; leave both for human review

Be conservative — pick "unsure" when there's no clear signal. Better to leave a competing pair than to silently drop the wrong one.

Output strictly the JSON shape requested.`;
    const user =
      `Entity context:\n${ctxFacts}\n\n` +
      `Fact A: ${pair.a.predicate} = "${pair.a.object}" ` +
      `(confidence=${pair.a.confidence.toFixed(2)}, validFrom=${pair.a.validFrom.slice(0, 10)}, recordedAt=${pair.a.recordedAt.slice(0, 10)})\n` +
      `Fact B: ${pair.b.predicate} = "${pair.b.object}" ` +
      `(confidence=${pair.b.confidence.toFixed(2)}, validFrom=${pair.b.validFrom.slice(0, 10)}, recordedAt=${pair.b.recordedAt.slice(0, 10)})`;

    try {
      const res = await withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.dreams_resolver',
          system: 'openai',
          model: this.model,
        },
        this.metrics,
        () => this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'resolve_verdict',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                verdict: {
                  type: 'string',
                  enum: ['a_wins', 'b_wins', 'unsure'],
                },
                rationale: { type: 'string' },
              },
              required: ['verdict', 'rationale'],
            },
          },
        },
        max_completion_tokens: 200,
        temperature: 0,
      }),
      );
      const content = res.choices[0]?.message?.content;
      if (!content) return { kind: 'unsure' };
      const parsed = JSON.parse(content) as {
        verdict: unknown;
        rationale: string;
      };
      if (parsed.verdict === 'a_wins') return { kind: 'a_wins' };
      if (parsed.verdict === 'b_wins') return { kind: 'b_wins' };
      return { kind: 'unsure' };
    } catch (err) {
      this.logger.warn(`Resolve judge failed: ${(err as Error).message}`);
      return { kind: 'unsure' };
    }
  }

  private async fetchEntityContext(
    db: Surreal,
    entityId: string,
  ): Promise<string> {
    type R = { predicate: string; object: string; recordedAt: string };
    const [rows] = await db.query<[R[]]>(
      `SELECT predicate, object, recordedAt FROM knowledge_fact
       WHERE entityId = $eid
         AND status = 'active'
         AND retractedAt IS NONE
       ORDER BY recordedAt DESC
       LIMIT 6`,
      { eid: new StringRecordId(entityId) },
    );
    const r = (rows as R[]) ?? [];
    if (r.length === 0) return '(no other active facts)';
    return r
      .map(
        (f) => `- [${f.recordedAt.slice(0, 10)}] ${f.predicate}: ${f.object}`,
      )
      .join('\n');
  }

  private async markSuperseded(
    db: Surreal,
    loserId: string,
    winnerId: string,
  ): Promise<void> {
    const loser = new StringRecordId(loserId);
    const winner = new StringRecordId(winnerId);
    // Match fn::resolve_fact's supersede shape (migration 0033). The old
    // version set only {status, supersededBy, retractionReason} and left
    // the loser's validUntil OPEN. Default-now search hid it via
    // status='superseded', but the asOf path gates purely on the validity
    // axis (validFrom/validUntil) — so the loser kept resurfacing in
    // point-in-time / audit reads. We must CLOSE the interval like the
    // resolver does: validUntil = winner.validFrom, priorValidUntil =
    // loser's original validUntil. retractedBy='dreams' preserves the
    // "auto-resolved by the dreams cron" audit signal that the old
    // retractionReason='dreams_resolution' tag carried.
    type Bound = { validFrom: string; validUntil: string | null };
    const [winRows] = await db.query<[Array<{ validFrom: string }>]>(
      `SELECT validFrom FROM $w`,
      { w: winner },
    );
    const [loseRows] = await db.query<[Bound[]]>(
      `SELECT validFrom, validUntil FROM $l`,
      { l: loser },
    );
    const winnerValidFrom = (winRows as Array<{ validFrom: string }>)?.[0]
      ?.validFrom;
    const loserRow = (loseRows as Bound[])?.[0];
    if (!winnerValidFrom || !loserRow) {
      // A row vanished between selection and here (concurrent forget /
      // compaction). Nothing safe to close — skip.
      return;
    }
    // Never produce an inverted interval: for a same-instant dedup the
    // winner's validFrom can equal/precede the loser's, so close no earlier
    // than the loser's own start.
    const closeAt =
      new Date(winnerValidFrom).getTime() >
      new Date(loserRow.validFrom).getTime()
        ? new Date(winnerValidFrom)
        : new Date(loserRow.validFrom);
    // option<datetime> rejects NULL, so only assign priorValidUntil when the
    // loser actually had a bounded interval to snapshot.
    const priorClause =
      loserRow.validUntil != null ? 'priorValidUntil = $priorValidUntil,' : '';
    await db.query(
      `UPDATE $loser SET
         status = 'superseded',
         retractionReason = 'superseded',
         retractedBy = 'dreams',
         supersededBy = $winner,
         ${priorClause}
         validUntil = $closeAt`,
      {
        loser,
        winner,
        closeAt,
        ...(loserRow.validUntil != null
          ? { priorValidUntil: new Date(loserRow.validUntil) }
          : {}),
      },
    );
  }
}
