import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { EmbedderService } from '../ai/embedder.service';
import { Semaphore } from '../common/semaphore';
import { withSpan } from '../common/tracing';

/**
 * DreamsDedupService — find near-duplicate ENTITIES inside a tenant
 * and emit identity_of links so survivor + loser collapse into one
 * search-side record.
 *
 * Two-stage filter:
 *   1. CHEAP: vector similarity over the entity's `name` fact embedding.
 *      For each candidate entity, fetch the K nearest neighbours by
 *      name-embedding cosine; consider any pair with cos ≥ threshold
 *      a SUSPECT.
 *   2. EXPENSIVE: LLM judge with both entities' top-3 facts as context.
 *      Verdict ∈ {same, different, unsure}. Only `same` triggers a
 *      RELATE knowledge_edge (kind='identity_of'); `unsure` is logged
 *      for operator review.
 *
 * Bounded per run by DREAMS_DEDUP_MAX_PAIRS so a single tenant can't
 * monopolise the off-hours budget. Skip pairs that already have an
 * identity_of edge (idempotent re-runs).
 *
 * Failure modes are explicit. LLM outage → mark suspect, log,
 * continue. Surreal outage → bubble up to the orchestrator which
 * tags the run outcome=hop_error and stops the chain.
 */
export interface DedupCandidate {
  aId: string;
  bId: string;
  cosine: number;
}

export interface DedupResult {
  suspectsEvaluated: number;
  llmJudgements: number;
  identityLinksCreated: number;
  unsurePairs: number;
}

@Injectable()
export class DreamsDedupService {
  private readonly logger = new Logger(DreamsDedupService.name);
  private readonly openai: OpenAI;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly cosineThreshold: number;
  private readonly maxPairs: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    private readonly embedder: EmbedderService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_DEDUP_ENABLED', '0') === '1';
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
      'DREAMS_DEDUP_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.cosineThreshold = parseFloat(
      this.configService.get<string>('DREAMS_DEDUP_COSINE_THRESHOLD', '0.92'),
    );
    this.maxPairs = parseInt(
      this.configService.get<string>('DREAMS_DEDUP_MAX_PAIRS', '50'),
      10,
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('DREAMS_DEDUP_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  /**
   * Run dedup for ONE tenant. The caller (DreamsService) owns the
   * Surreal connection and tenant scoping — we just operate over the
   * passed `db` handle. This keeps the service stateless and
   * compatible with the controller's per-request manual trigger.
   */
  async run(db: Surreal): Promise<DedupResult> {
    const result: DedupResult = {
      suspectsEvaluated: 0,
      llmJudgements: 0,
      identityLinksCreated: 0,
      unsurePairs: 0,
    };
    if (!this.isEnabled()) return result;

    const candidates = await withSpan(
      'dreams.dedup.find_candidates',
      () => this.findCandidates(db),
      { 'dedup.cosine_threshold': this.cosineThreshold },
    );
    result.suspectsEvaluated = candidates.length;
    if (candidates.length === 0) return result;

    for (const cand of candidates) {
      // Skip pairs that already have an identity_of edge — idempotent.
      const exists = await this.identityEdgeExists(db, cand.aId, cand.bId);
      if (exists) continue;

      const verdict = await withSpan(
        'dreams.dedup.judge',
        () => this.limiter.run(() => this.judge(db, cand)),
      );
      result.llmJudgements++;
      if (verdict === 'same') {
        await this.linkIdentity(db, cand.aId, cand.bId);
        result.identityLinksCreated++;
      } else if (verdict === 'unsure') {
        result.unsurePairs++;
        this.logger.warn(
          `[dreams.dedup] unsure pair: ${cand.aId} ⟷ ${cand.bId} (cos=${cand.cosine.toFixed(3)})`,
        );
      }
    }
    return result;
  }

  /**
   * Find suspect pairs. Strategy:
   *   - Pull every entity that has a `name` fact (the dedup signal).
   *     Limited to entities owning at least ONE fact whose embedding
   *     is non-NONE (post-compaction warm tier is excluded — those
   *     entities can't be embedding-matched cheaply).
   *   - For each, take its newest active `name` fact's embedding.
   *   - Run a Surreal HNSW-cosine k-NN over the name embedding,
   *     keep only pairs with cos ≥ threshold AND aId < bId (canonical
   *     ordering so each pair is counted once).
   *   - Cap at maxPairs to bound the LLM cost.
   */
  private async findCandidates(db: Surreal): Promise<DedupCandidate[]> {
    type NameRow = { entityId: unknown; embedding: number[] };
    const [seedRows] = await db.query<[NameRow[]]>(
      `SELECT entityId, embedding FROM knowledge_fact
       WHERE predicate = 'name'
         AND status = 'active'
         AND retractedAt IS NONE
         AND embedding != NONE`,
    );
    const seeds = (seedRows as NameRow[]) ?? [];
    if (seeds.length < 2) return [];

    const out: DedupCandidate[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const aId = String(seed.entityId);
      // K-NN over name facts. We ask for K=5 to surface the closest
      // candidates without flooding the LLM stage; the threshold
      // then filters most away.
      const sql = `
        SELECT entityId, vector::similarity::cosine(embedding, $q) AS sim
        FROM knowledge_fact
        WHERE predicate = 'name'
          AND status = 'active'
          AND retractedAt IS NONE
          AND embedding != NONE
        ORDER BY sim DESC
        LIMIT 5
      `;
      const [neighbourRows] = await db.query<
        [Array<{ entityId: unknown; sim: number }>]
      >(sql, { q: seed.embedding });
      for (const n of (neighbourRows as Array<{ entityId: unknown; sim: number }>) ?? []) {
        const bId = String(n.entityId);
        if (bId === aId) continue;
        if (n.sim < this.cosineThreshold) continue;
        const pairKey = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        out.push({
          aId: aId < bId ? aId : bId,
          bId: aId < bId ? bId : aId,
          cosine: n.sim,
        });
        if (out.length >= this.maxPairs) return out;
      }
    }
    return out;
  }

  private async identityEdgeExists(
    db: Surreal,
    aId: string,
    bId: string,
  ): Promise<boolean> {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM knowledge_edge
       WHERE kind = 'identity_of'
         AND ((in = $a AND out = $b) OR (in = $b AND out = $a))
       LIMIT 1`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
    return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
  }

  /**
   * Ask the LLM whether two entities (with a few facts each) are
   * likely the same real-world thing. Strict JSON schema, identity-
   * fallback `unsure` on any parsing failure.
   */
  private async judge(
    db: Surreal,
    cand: DedupCandidate,
  ): Promise<'same' | 'different' | 'unsure'> {
    const factsA = await this.fetchTopFacts(db, cand.aId);
    const factsB = await this.fetchTopFacts(db, cand.bId);

    const sys = `You decide whether two knowledge-graph entities are the SAME real-world thing or DIFFERENT things that happen to share a similar name.

Use the facts as the only evidence. Reasoning patterns:
- "same" — facts directly identify them (matching dob / email / address) OR facts are non-contradictory and the names are identical / clear aliases.
- "different" — facts contradict (different dob / different email / different employer at same time).
- "unsure" — the facts don't disambiguate either way (just names + occupation, common name).

Output strictly the JSON shape requested. No preamble.`;
    const user =
      `Entity A:\n${factsA}\n\n` +
      `Entity B:\n${factsB}\n\n` +
      `Cosine name-similarity: ${cand.cosine.toFixed(3)}.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'dedup_verdict',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                verdict: {
                  type: 'string',
                  enum: ['same', 'different', 'unsure'],
                },
              },
              required: ['verdict'],
            },
          },
        },
        max_completion_tokens: 64,
        temperature: 0,
      });
      const content = res.choices[0]?.message?.content;
      if (!content) return 'unsure';
      const parsed = JSON.parse(content) as { verdict: unknown };
      if (
        parsed.verdict === 'same' ||
        parsed.verdict === 'different' ||
        parsed.verdict === 'unsure'
      ) {
        return parsed.verdict;
      }
      return 'unsure';
    } catch (err) {
      this.logger.warn(`Dedup judge failed: ${(err as Error).message}`);
      return 'unsure';
    }
  }

  private async fetchTopFacts(db: Surreal, entityId: string): Promise<string> {
    type R = { predicate: string; object: string };
    const [rows] = await db.query<[R[]]>(
      `SELECT predicate, object FROM knowledge_fact
       WHERE entityId = $eid
         AND status = 'active'
         AND retractedAt IS NONE
       ORDER BY confidence DESC
       LIMIT 5`,
      { eid: new StringRecordId(entityId) },
    );
    const r = (rows as R[]) ?? [];
    if (r.length === 0) return '(no facts)';
    return r.map((f) => `- ${f.predicate}: ${f.object}`).join('\n');
  }

  private async linkIdentity(
    db: Surreal,
    aId: string,
    bId: string,
  ): Promise<void> {
    // Direction: aId → bId. The conventional survivor/loser policy
    // (older entity wins) is enforced by the existing identity-merge
    // path in the search service via mergedInto reattribution; from
    // dreams we just emit the link with weight 1.0 and source tag.
    await db.query(
      `RELATE $a->knowledge_edge->$b SET kind = 'identity_of', weight = 1.0,
        source = { vertical: 'dreams', kind: 'auto_dedup' },
        createdAt = time::now()`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
  }
}
