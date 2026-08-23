import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { createOpenAiClient } from '../ai/openai-client';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import { PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { envFlagEnabled } from '../common/env-validation';
import { derivedVersionFence } from '../episodes/read-pin.service';

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
 *   - predicate semantics: seed 'bitemporal' claims sweep; seed
 *     'append_only' stays out (event history — two similar events are
 *     two events; single_active never has two active rows). Predicates
 *     UNKNOWN to the JS seed are open-vocabulary coinages (0082): they
 *     write as append_only, but fuzzy same-assertion corroboration is
 *     exactly what collapses re-worded coinages, so they sweep like
 *     claims — the LLM judge is the backstop;
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
  /** Candidate groups examined this run (≤ the window). */
  groupsConsidered: number;
  /** Total eligible groups BEFORE the per-run window — the true backlog.
   *  groupBacklog > groupsConsidered means the run left work on the table
   *  (bounded by DREAMS_CORROBORATE_MAX_PAIRS); watch it trend down. */
  groupBacklog: number;
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
  private readonly maxLlmCalls: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      envFlagEnabled(this.configService.get<string>('DREAMS_CORROBORATE_ENABLED'));
    this.openai =
      createOpenAiClient(this.configService) ?? (undefined as unknown as OpenAI);
    this.model = this.configService.get<string>(
      'DREAMS_CORROBORATE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.maxPairs = parseInt(
      this.configService.get<string>('DREAMS_CORROBORATE_MAX_PAIRS', '20'),
      10,
    );
    // Hard ceiling on judge calls per run. maxPairs caps APPLIED
    // corroborations only — 'different'/'unsure' verdicts don't count
    // toward it, so a window full of non-matching pairs could burn
    // (window × pairs-per-group) LLM calls (~280) against a nominal
    // cap of 20. Default 2× the window.
    this.maxLlmCalls = parseInt(
      this.configService.get<string>(
        'DREAMS_CORROBORATE_MAX_LLM_CALLS',
        String(this.maxPairs * 2),
      ),
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

  async run(
    db: Surreal,
    derivedVersion: string | null = null,
  ): Promise<CorroborateResult> {
    const result: CorroborateResult = {
      groupsConsidered: 0,
      groupBacklog: 0,
      pairsConsidered: 0,
      llmJudgements: 0,
      corroborationsApplied: 0,
      unsurePairs: 0,
      corroborations: [],
    };
    if (!this.isEnabled()) return result;

    const { groups, backlog } = await withSpan(
      'dreams.corroborate.find_groups',
      () => this.findCandidateGroups(db, derivedVersion),
    );
    result.groupsConsidered = groups.length;
    result.groupBacklog = backlog;
    if (backlog > groups.length) {
      // The window is bounded by maxPairs*2; anything past it waits for a
      // later run. Surface the depth so a persistent backlog is visible
      // instead of silently draining ~maxPairs/night.
      this.logger.warn(
        `[dreams.corroborate] ${backlog} eligible groups, only ${groups.length} in this run's window — backlog draining at ≤${this.maxPairs}/run`,
      );
    }

    for (const group of groups) {
      if (result.corroborationsApplied >= this.maxPairs) break;
      // Hard judge-call ceiling: 'different'/'unsure' verdicts never
      // count toward maxPairs, so without this a window of
      // non-matching groups kept burning LLM calls all the way through.
      if (result.llmJudgements >= this.maxLlmCalls) {
        this.logger.warn(
          `[dreams.corroborate] LLM call ceiling ${this.maxLlmCalls} reached — ${result.llmJudgements} judgements this run; remaining groups wait for the next run`,
        );
        break;
      }
      const members = await this.fetchGroupMembers(db, group, derivedVersion);
      const pairs = this.selectPairs(members);

      // Judge in parallel under the semaphore, apply serially. The old
      // per-iteration await never let the Semaphore hold more than one
      // task, making DREAMS_CORROBORATE_CONCURRENCY a no-op — the
      // nightly leg ran at 1× LLM latency. Exact-object matches skip
      // the judge entirely. Within-group calls may overshoot the
      // ceiling by at most the group's pair count (≤ MAX_GROUP_SIZE).
      const judged = await Promise.all(
        pairs.map((pair) => {
          result.pairsConsidered++;
          if (pair.younger.object.trim() === pair.incumbent.object.trim()) {
            return Promise.resolve({ pair, verdict: 'exact' as const });
          }
          result.llmJudgements++;
          return withSpan('dreams.corroborate.judge', () =>
            this.limiter.run(() => this.judge(pair)),
          ).then((verdict) => ({ pair, verdict }));
        }),
      );

      for (const { pair, verdict } of judged) {
        if (result.corroborationsApplied >= this.maxPairs) break;
        if (verdict === 'unsure') {
          result.unsurePairs++;
          this.logger.warn(
            `[dreams.corroborate] unsure: entity=${String(pair.incumbent.entityId)} predicate=${pair.incumbent.predicate} a='${pair.incumbent.object}' vs b='${pair.younger.object}'`,
          );
          continue;
        }
        if (verdict === 'different') continue;
        const method: 'exact' | 'llm' = verdict === 'exact' ? 'exact' : 'llm';
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

      // Negative-result memo (migration 0060): remember the group's
      // member count so a group whose membership hasn't changed is not
      // re-fetched and re-judged every night. Groups that DID apply a
      // corroboration change their active-member count (the younger row
      // turns 'corroborating'), so the memo self-invalidates for them.
      await this.markGroupChecked(db, group, members.length);
    }
    return result;
  }

  private async markGroupChecked(
    db: Surreal,
    group: { entityId: unknown; predicate: string },
    memberCount: number,
  ): Promise<void> {
    try {
      await db.query(
        `UPSERT corroborate_checked SET
           entityId = $entity, predicate = $predicate,
           memberCount = $n, checkedAt = time::now()
         WHERE entityId = $entity AND predicate = $predicate`,
        {
          entity: new StringRecordId(String(group.entityId)),
          predicate: group.predicate,
          n: memberCount,
        },
      );
    } catch (e) {
      // Best-effort: a missed memo only costs a re-judge next run.
      this.logger.warn(
        `[dreams.corroborate] checked-memo write failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * (entityId, predicate) groups holding ≥2 active embedded facts, in a
   * DETERMINISTIC order (most-populated first, then a stable id tiebreak).
   * Without an explicit order the window was arbitrary SurrealDB storage
   * order, so which groups got corroborated each night was non-deterministic
   * and a group could be starved indefinitely. Returns the windowed slice
   * plus the true eligible backlog so the caller can surface the depth.
   */
  private async findCandidateGroups(
    db: Surreal,
    derivedVersion: string | null,
  ): Promise<{
    groups: Array<{ entityId: unknown; predicate: string }>;
    backlog: number;
  }> {
    const fence = derivedVersionFence(derivedVersion);
    const [rawRows] = await db.query<
      [Array<{ entityId: unknown; canonPredicate: string; n: number }>]
    >(
      // 0082: groups key on the CANONICAL predicate so coinages of one
      // canon land in the same group; fetchGroupMembers mirrors the key.
      `SELECT entityId, predicateAlias ?? predicate AS canonPredicate,
              count() AS n FROM knowledge_fact
       WHERE status = 'active' AND retractedAt IS NONE AND embedding != NONE
         AND userId IS NONE
         ${fence.clause}
       GROUP BY entityId, canonPredicate`,
      fence.params,
    );
    const rows = (
      (rawRows as Array<{
        entityId: unknown;
        canonPredicate: string;
        n: number;
      }>) ?? []
    ).map((r) => ({ entityId: r.entityId, predicate: r.canonPredicate, n: r.n }));
    // Negative-result memo (0060): a group already judged at the SAME
    // member count is excluded before the window is cut. Without this,
    // the deterministic most-populated-first order re-selected the same
    // all-'different' groups every night — permanent starvation of the
    // rest of the backlog at full LLM cost.
    const checked = await this.loadCheckedMemo(db);
    const eligible = rows
      .filter((g) => g.n >= 2 && g.n <= MAX_GROUP_SIZE)
      .filter((g) => {
        // 0082: seed lookup, not policyFor — the fallback for unknown
        // predicates is append_only now, but an unknown (coined)
        // predicate is an observation whose re-worded duplicates only
        // this sweep can collapse. Known seeds keep the old rule.
        const seed = PREDICATE_POLICIES[g.predicate];
        return seed ? seed.semantics === 'bitemporal' : true;
      })
      .filter(
        (g) => checked.get(`${String(g.entityId)}|${g.predicate}`) !== g.n,
      )
      .sort((a, b) => {
        if (b.n !== a.n) return b.n - a.n; // most-conflicted first
        const ka = `${String(a.entityId)}\u0000${a.predicate}`;
        const kb = `${String(b.entityId)}\u0000${b.predicate}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0; // stable tiebreak
      });
    return { groups: eligible.slice(0, this.maxPairs * 2), backlog: eligible.length };
  }

  /** (entityId|predicate) → memberCount at last check. Empty on error. */
  private async loadCheckedMemo(db: Surreal): Promise<Map<string, number>> {
    const memo = new Map<string, number>();
    try {
      const [rows] = await db.query<
        [Array<{ entityId: unknown; predicate: string; memberCount: number }>]
      >(`SELECT entityId, predicate, memberCount FROM corroborate_checked`);
      for (const r of (rows as Array<{
        entityId: unknown;
        predicate: string;
        memberCount: number;
      }>) ?? []) {
        memo.set(`${String(r.entityId)}|${r.predicate}`, r.memberCount);
      }
    } catch (e) {
      this.logger.warn(
        `[dreams.corroborate] checked-memo read failed (${(e as Error).message}); treating all groups as unchecked`,
      );
    }
    return memo;
  }

  private async fetchGroupMembers(
    db: Surreal,
    group: { entityId: unknown; predicate: string },
    derivedVersion: string | null,
  ): Promise<ActiveFactRow[]> {
    const fence = derivedVersionFence(derivedVersion);
    const [rows] = await db.query<[ActiveFactRow[]]>(
      // 0082: the group key is the CANONICAL predicate — membership
      // matches on `predicateAlias ?? predicate` so coinages join their
      // canon's group.
      `SELECT id, entityId, predicate, object, validFrom, validUntil,
              recordedAt, embedding,
              fn::origin_key_of(source) AS originKey,
              corroboration.count ?? 0 AS corroborationCount
       FROM knowledge_fact
       WHERE entityId = $entity AND (predicateAlias ?? predicate) = $predicate
         AND status = 'active' AND retractedAt IS NONE AND embedding != NONE
         AND userId IS NONE
         ${fence.clause}
       ORDER BY recordedAt ASC`,
      {
        entity: new StringRecordId(String(group.entityId)),
        predicate: group.predicate,
        ...fence.params,
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
      const younger = members[j]!; // j < members.length ⇒ in-bounds
      if (younger.corroborationCount > 0) continue;
      let best: { incumbent: ActiveFactRow; sim: number } | null = null;
      for (let i = 0; i < j; i++) {
        const older = members[i]!; // i < j < members.length ⇒ in-bounds
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
    // a.length === b.length (checked above) ⇒ both indices are in-bounds.
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
