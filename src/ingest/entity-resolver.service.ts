import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { EmbedderService } from '../ai/embedder.service';
import { MetricsService } from '../metrics/metrics.service';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';

/**
 * EntityResolverService — inline entity resolution at ingest time
 * (graphiti-style). Before the mention pipeline mints a NEW entity for an
 * extracted name that missed the exact canonicalName match, we look for a
 * near-duplicate that already exists and, when an LLM judge confirms it's
 * the same real-world thing, reuse it — so the duplicate is never created.
 *
 * Why an LLM judge and not bare cosine: two different "John Smith"s have
 * near-identical name embeddings and the same type; merging on cosine
 * alone would wrongly fuse them. The judge looks at the FACTS (dob /
 * email / employer) — the existing entity's stored facts vs the incoming
 * mention's freshly-extracted facts (already in memory, not yet written)
 * — exactly as the off-hours dreams dedup does, just for one pair, inline.
 *
 * Scope: the free-text mention path only. Structured `POST /v1/ingest/fact`
 * with an explicit `vertical:id` stays authoritative (externalRef).
 *
 * Gated by INGEST_INLINE_RESOLUTION_ENABLED (default off). Any failure /
 * timeout falls back to "create new" — inline resolution must never block
 * or fail an ingest.
 *
 * Provenance (deliberate, graphiti-parity): a confirmed match REUSES the
 * existing entity rather than creating a duplicate + an `identity_of` edge
 * the way the off-hours dreams dedup does. So there is no reversible merge
 * edge to unlink — the trade-off for never materialising the duplicate.
 * Mitigations: the judge prefers "different" when unsure; each ingested
 * fact still carries its own `source` (messageId / vertical), so per-fact
 * origin is auditable; and the decision is logged. If a wrong fuse is ever
 * a concern for a tenant, leave the flag off and rely on dreams (reversible
 * edges) instead.
 *
 * DEDUP NOTE: the LLM judge + fetchTopFacts + OpenAI/Semaphore setup mirror
 * DreamsDedupService (one-pair vs candidate-scan framing). Extracting a
 * shared EntityJudge that serves both call sites is tracked as a follow-up;
 * kept duplicated here to keep this feature PR off the dreams hot path.
 */
@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);
  private readonly openai: OpenAI;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly cosineFloor: number;
  private readonly candidateK: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: ConfigService,
    private readonly embedder: EmbedderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED', '0') === '1';
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this.openai = apiKey
      ? new OpenAI({
          apiKey,
          timeout: parseInt(
            this.config.get<string>('OPENAI_TIMEOUT_MS', '30000'),
            10,
          ),
          maxRetries: parseInt(
            this.config.get<string>('OPENAI_MAX_RETRIES', '3'),
            10,
          ),
        })
      : (undefined as unknown as OpenAI);
    this.model = this.config.get<string>(
      'INGEST_INLINE_RESOLUTION_MODEL',
      this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.cosineFloor = parseFloat(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_COSINE_FLOOR', '0.85'),
    );
    this.candidateK = parseInt(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_CANDIDATES', '5'),
      10,
    );
    this.limiter = new Semaphore(
      parseInt(
        this.config.get<string>('INGEST_INLINE_RESOLUTION_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  /**
   * Resolve an extracted entity to an EXISTING entity id when a confident
   * same-as match is found, otherwise null (caller creates a new entity).
   *
   * @param name   the extracted entity name (also its `name` fact object)
   * @param type   the normalized entity type (must match the candidate's)
   * @param incomingFacts  the mention's freshly-extracted facts for THIS
   *   entity, as `"predicate: object"` lines — the judge's "new" side.
   */
  async resolveByName(
    db: Surreal,
    name: string,
    type: string,
    incomingFacts: string[],
  ): Promise<string | null> {
    if (!this.isEnabled()) return null;
    try {
      const candidate = await this.findBestNameCandidate(db, name, type);
      if (!candidate) return null;

      const existingFacts = await this.fetchTopFacts(db, candidate.entityId);
      const verdict = await this.limiter.run(() =>
        this.judge(name, existingFacts, incomingFacts),
      );
      if (verdict === 'same') {
        this.logger.log(
          `[ingest.inline_resolution] reused ${candidate.entityId} for "${name}" ` +
            `(cos=${candidate.cosine.toFixed(3)})`,
        );
        return candidate.entityId;
      }
      return null;
    } catch (err) {
      // Never block ingest — fall back to "create new".
      this.logger.warn(
        `[ingest.inline_resolution] failed for "${name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Cosine k-NN over existing `name` fact embeddings; returns the closest
   * candidate of the SAME type at or above the floor, else null. Mirrors
   * the dreams dedup candidate scan, scoped to one query.
   */
  private async findBestNameCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<{ entityId: string; cosine: number } | null> {
    const q = await this.embedder.embed(`name: ${name}`);
    const [rows] = await db.query<
      [Array<{ entityId: unknown; etype: string; sim: number }>]
    >(
      `SELECT entityId, entityId.type AS etype,
              vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_fact
         WHERE predicate = 'name'
           AND status = 'active'
           AND retractedAt IS NONE
           AND embedding != NONE
         ORDER BY sim DESC
         LIMIT $k`,
      { q, k: this.candidateK },
    );
    for (const r of (rows as Array<{ entityId: unknown; etype: string; sim: number }>) ?? []) {
      if (r.sim < this.cosineFloor) break; // rows are sorted DESC
      if (r.etype !== type) continue;
      return { entityId: String(r.entityId), cosine: r.sim };
    }
    return null;
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

  /**
   * LLM same/different/unsure verdict — the dreams dedup judge, one pair.
   * factsB is the incoming mention's extracted facts (the entity isn't in
   * the graph yet, so its disambiguating evidence comes from extraction).
   */
  private async judge(
    name: string,
    existingFacts: string,
    incomingFacts: string[],
  ): Promise<'same' | 'different' | 'unsure'> {
    const factsB =
      incomingFacts.length > 0
        ? incomingFacts.map((f) => `- ${f}`).join('\n')
        : '(no facts)';
    const sys = `You decide whether a newly-mentioned entity is the SAME real-world thing as an existing knowledge-graph entity, or a DIFFERENT thing that happens to share a similar name.

Use the facts as the only evidence. Reasoning patterns:
- "same" — facts directly identify them (matching dob / email / address / employer) OR facts are non-contradictory and the names are identical / clear aliases.
- "different" — facts contradict (different dob / different email / different employer at the same time).
- "unsure" — the facts don't disambiguate either way (just names + occupation, common name).

When unsure, prefer "different" — wrongly fusing two distinct entities is worse than a transient duplicate the off-hours pass can still merge.

Output strictly the JSON shape requested. No preamble.`;
    const user =
      `Existing entity facts:\n${existingFacts}\n\n` +
      `Newly-mentioned entity "${name}" facts:\n${factsB}`;

    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.inline_resolution',
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
              name: 'resolution_verdict',
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
        }),
    );
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
  }
}
