import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import { policyFor } from '../ingest/conflict-resolver';

/**
 * DreamsCorroborateService — fuzzy cross-source corroboration.
 *
 * Ingest-time corroboration (migrations 0047/0050/0051) matches on
 * EXACT object equality: "tier: gold" from a second origin confirms the
 * incumbent. The same claim WORDED differently ("gold tier customer")
 * sails past the equality check and lands as a separate active fact —
 * near-duplicates accumulate and independent confirmation is lost.
 *
 * This nightly pass finds same-(entity, predicate) active pairs whose
 * objects are cosine-similar but not equal, from DIFFERENT origins,
 * with overlapping validity, and asks an LLM whether they assert the
 * SAME fact. On "same": the younger row becomes status='corroborating'
 * pointing at the older incumbent, and the incumbent's corroboration
 * accumulator is bumped with the 0051 origin-dedup semantics (count =
 * distinct origins) — the exact shape fn::resolve_fact writes, using
 * the same fn::origin_key_of / fn::source_key_of helpers.
 *
 * Guards, in order of importance:
 *   - different origin (one document re-worded is NOT confirmation);
 *   - validity intervals overlap (sequential states are history, not
 *     the same claim);
 *   - predicate semantics 'bitemporal' (append_only predicates are
 *     event history — two similar events are two events; single_active
 *     never has two active rows). JS policyFor is the legacy lookup, so
 *     tenant-pack predicates unknown to it default to bitemporal — the
 *     LLM judge is the backstop for those;
 *   - exactly-equal objects skip the LLM (deterministic corroboration —
 *     these only exist for pairs that never conflicted at ingest);
 *   - LLM verdict 'same_assertion' required for everything else;
 *     'unsure' defaults to no action, same as the resolver.
 *
 * Bounded by DREAMS_CORROBORATE_MAX_PAIRS per run. Default off
 * (DREAMS_CORROBORATE_ENABLED).
 */
export interface CorroborationApplied {
  incumbentFactId: string;
  corroboratingFactId: string;
  predicate: string;
  entityId: string;
  incumbentObject: string;
  corroboratingObject: string;
  method: 'exact' | 'llm';
}

export interface CorroborateResult {
  groupsConsidered: number;
  pairsConsidered: number;
  llmJudgements: number;
  corroborationsApplied: number;
  unsurePairs: number;
  corroborations: CorroborationApplied[];
}

interface ActiveFactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string | null;
  recordedAt: string;
  embedding: number[];
  originKey: string;
  corroborationCount: number;
}

/** Skip groups larger than this — claim-shaped predicates hold a handful
 *  of active rows; dozens means event-shaped data we must not touch. */
const MAX_GROUP_SIZE = 8;

@Injectable()
export class DreamsCorroborateService {
  private readonly logger = new Logger(DreamsCorroborateService.name);
  private readonly openai: OpenAI;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly maxPairs: number;
  private readonly cosineThreshold: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_CORROBORATE_ENABLED', '0') === '1';
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
      'DREAMS_CORROBORATE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.maxPairs = parseInt(
      this.configService.get<string>('DREAMS_CORROBORATE_MAX_PAIRS', '20'),
      10,
    );
    this.cosineThreshold = parseFloat(
      this.configService.get<string>(
        'DREAMS_CORROBORATE_COSINE_THRESHOLD',
        '0.9',
      ),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('DREAMS_CORROBORATE_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  async run(db: Surreal): Promise<CorroborateResult> {
    const result: CorroborateResult = {
      groupsConsidered: 0,
      pairsConsidered: 0,
      llmJudgements: 0,
      corroborationsApplied: 0,
      unsurePairs: 0,
      corroborations: [],
    };
    if (!this.isEnabled()) return result;

    const groups = await withSpan('dreams.corroborate.find_groups', () =>
      this.findCandidateGroups(db),
    );
    result.groupsConsidered = groups.length;

    for (const group of groups) {
      if (result.corroborationsApplied >= this.maxPairs) break;
      const members = await this.fetchGroupMembers(db, group);
      const pairs = this.selectPairs(members);
      for (const pair of pairs) {
        if (result.corroborationsApplied >= this.maxPairs) break;
        result.pairsConsidered++;
        let method: 'exact' | 'llm';
        if (pair.younger.object.trim() === pair.incumbent.object.trim()) {
          method = 'exact';
        } else {
          const verdict = await withSpan('dreams.corroborate.judge', () =>
            this.limiter.run(() => this.judge(pair)),
          );
          result.llmJudgements++;
          if (verdict === 'unsure') {
            result.unsurePairs++;
            this.logger.warn(
              `[dreams.corroborate] unsure: entity=${String(pair.incumbent.entityId)} predicate=${pair.incumbent.predicate} a='${pair.incumbent.object}' vs b='${pair.younger.object}'`,
            );
            continue;
          }
          if (verdict === 'different') continue;
          method = 'llm';
        }
        await this.applyCorroboration(db, pair);
        result.corroborationsApplied++;
        result.corroborations.push({
          incumbentFactId: String(pair.incumbent.id),
          corroboratingFactId: String(pair.younger.id),
          predicate: pair.incumbent.predicate,
          entityId: String(pair.incumbent.entityId),
          incumbentObject: pair.incumbent.object,
          corroboratingObject: pair.younger.object,
          method,
        });
      }
    }
    return result;
  }

  /** (entityId, predicate) groups holding ≥2 active embedded facts. */
  private async findCandidateGroups(
    db: Surreal,
  ): Promise<Array<{ entityId: unknown; predicate: string }>> {
    const [rows] = await db.query<
      [Array<{ entityId: unknown; predicate: string; n: number }>]
    >(
      `SELECT entityId, predicate, count() AS n FROM knowledge_fact
       WHERE status = 'active' AND retractedAt IS NONE AND embedding != NONE
       GROUP BY entityId, predicate`,
    );
    return ((rows as Array<{ entityId: unknown; predicate: string; n: number }>) ?? [])
      .filter((g) => g.n >= 2 && g.n <= MAX_GROUP_SIZE)
      .filter((g) => policyFor(g.predicate).semantics === 'bitemporal')
      .slice(0, this.maxPairs * 2);
  }

  private async fetchGroupMembers(
    db: Surreal,
    group: { entityId: unknown; predicate: string },
  ): Promise<ActiveFactRow[]> {
    const [rows] = await db.query<[ActiveFactRow[]]>(
      `SELECT id, entityId, predicate, object, validFrom, validUntil,
              recordedAt, embedding,
              fn::origin_key_of(source) AS originKey,
              corroboration.count ?? 0 AS corroborationCount
       FROM knowledge_fact
       WHERE entityId = $entity AND predicate = $predicate
         AND status = 'active' AND retractedAt IS NONE AND embedding != NONE
       ORDER BY recordedAt ASC`,
      {
        entity: new StringRecordId(String(group.entityId)),
        predicate: group.predicate,
      },
    );
    return (rows as ActiveFactRow[]) ?? [];
  }

  /**
   * Eligible (incumbent=older, younger) pairs: different origin,
   * overlapping validity, cosine ≥ threshold. Each younger corroborates
   * at most its single best-matching older row; a younger that is
   * itself already corroborated stays untouched (retagging it would
   * hide a row other rows point at).
   */
  private selectPairs(
    members: ActiveFactRow[],
  ): Array<{ incumbent: ActiveFactRow; younger: ActiveFactRow }> {
    const pairs: Array<{ incumbent: ActiveFactRow; younger: ActiveFactRow }> =
      [];
    for (let j = 1; j < members.length; j++) {
      const younger = members[j];
      if (younger.corroborationCount > 0) continue;
      let best: { incumbent: ActiveFactRow; sim: number } | null = null;
      for (let i = 0; i < j; i++) {
        const older = members[i];
        if (older.originKey === younger.originKey) continue;
        if (!intervalsOverlap(older, younger)) continue;
        const sim = cosine(older.embedding, younger.embedding);
        if (sim < this.cosineThreshold) continue;
        if (!best || sim > best.sim) best = { incumbent: older, sim };
      }
      if (best) pairs.push({ incumbent: best.incumbent, younger });
    }
    return pairs;
  }

  /** "Do A and B assert the same fact?" Strict schema; unsure on any failure. */
  private async judge(pair: {
    incumbent: ActiveFactRow;
    younger: ActiveFactRow;
  }): Promise<'same_assertion' | 'different' | 'unsure'> {
    const sys = `You judge whether two knowledge-graph facts are the SAME ASSERTION worded differently.

Both share the same entity and predicate. Answer same_assertion ONLY when B independently confirms exactly what A claims — a paraphrase, translation, or re-wording of one underlying fact.

Answer different when:
- the values genuinely differ ("gold" vs "platinum" — a contradiction, not confirmation);
- they describe two separate occurrences of the same KIND of thing (two visits, two complaints, two payments — repeated events are not one fact);
- one is more specific in a way that changes the claim.

Answer unsure when you cannot tell. Unsure is always safe.`;
    const user = `Predicate: ${pair.incumbent.predicate}
A (recorded ${pair.incumbent.recordedAt}): ${pair.incumbent.object}
B (recorded ${pair.younger.recordedAt}): ${pair.younger.object}`;
    try {
      const res = await withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.dreams_corroborate',
          system: 'openai',
          model: this.model,
        },
        this.metrics,
        () =>
          this.openai.chat.completions.create({
            model: this.model,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'corroboration_verdict',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    verdict: {
                      type: 'string',
                      enum: ['same_assertion', 'different', 'unsure'],
                    },
                    reason: { type: 'string' },
                  },
                  required: ['verdict', 'reason'],
                },
              },
            },
            max_completion_tokens: 128,
            temperature: 0,
          }),
      );
      const content = res.choices[0]?.message?.content;
      if (!content) return 'unsure';
      const parsed = JSON.parse(content) as { verdict?: string };
      if (
        parsed.verdict === 'same_assertion' ||
        parsed.verdict === 'different'
      ) {
        return parsed.verdict;
      }
      return 'unsure';
    } catch (e) {
      this.logger.warn(
        `[dreams.corroborate] judge failed: ${(e as Error).message}`,
      );
      return 'unsure';
    }
  }

  /**
   * The 0051 corroboration write, verbatim shape: younger →
   * status='corroborating' pointing at the incumbent; incumbent's
   * accumulator unioned by origin so count only grows on genuinely new
   * origins. Key derivation delegates to the same stored fns the
   * resolver uses — one definition of "origin".
   */
  private async applyCorroboration(
    db: Surreal,
    pair: { incumbent: ActiveFactRow; younger: ActiveFactRow },
  ): Promise<void> {
    const younger = new StringRecordId(String(pair.younger.id));
    const incumbent = new StringRecordId(String(pair.incumbent.id));
    await db.query(
      `LET $origin_key = fn::origin_key_of($younger.source);
       LET $src_key = fn::source_key_of($younger.source);
       UPDATE $younger SET
         status = 'corroborating',
         corroborates = $incumbent;
       UPDATE $incumbent SET corroboration = {
         count: array::len(array::union(
           IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
           [$origin_key]
         )),
         sourceKeys: array::union(
           IF corroboration IS NONE THEN [] ELSE corroboration.sourceKeys END,
           [$src_key]
         ),
         originKeys: array::union(
           IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
           [$origin_key]
         ),
         lastAt: time::now()
       };`,
      { younger, incumbent },
    );
  }
}

/** Allen overlap with NONE validUntil as +∞ — mirrors fn::intervals_overlap. */
function intervalsOverlap(
  a: { validFrom: string; validUntil?: string | null },
  b: { validFrom: string; validUntil?: string | null },
): boolean {
  const aFrom = new Date(a.validFrom).getTime();
  const bFrom = new Date(b.validFrom).getTime();
  const aUntil = a.validUntil ? new Date(a.validUntil).getTime() : Infinity;
  const bUntil = b.validUntil ? new Date(b.validUntil).getTime() : Infinity;
  return aFrom < bUntil && bFrom < aUntil;
}

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
