import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';

/**
 * Lane C composer, v1: per-entity ASPECT AGGREGATES
 * (docs/roadmap/memory-substrate-redesign-2026-07.md §2.8).
 *
 * Enumeration questions ("what activities has X done", "what are X's
 * pets' names") are the measured multi-hop ABSENT mass: every member
 * fact exists, but no single retrievable fact carries the enumeration,
 * and top-k sampling surfaces a subset. This composer spends write-time
 * compute to pre-answer them: for the fact-densest entities it asks an
 * LLM to group atomic facts into enumerable aspects and writes one
 * self-contained aggregate proposition per aspect as a NORMAL
 * knowledge_fact — so aggregates ride the existing retrieval lanes
 * (vector + BM25 + fact-centric) with zero read-path changes, carry
 * `derivedFrom` provenance (the 0072 staleness cascade sees them), and
 * are recognizable/replaceable via `source.recorder`.
 *
 * Deliberately NOT routed through fn::resolve_fact: these are synthetic
 * derived rows — the bitemporal resolver's supersede/corroborate
 * semantics are for observations, and a re-run replaces aggregates
 * wholesale (delete-by-recorder, then create).
 */
export const AGGREGATE_RECORDER = 'aggregate-composer-v1';

const COMPOSER_SYSTEM = `You build AGGREGATE memory facts for one person from their atomic facts.

Group the facts into enumerable ASPECTS (examples: activities, pets, family_members, places_visited, books_and_media, health, possessions, events_attended, work_projects). For each aspect with AT LEAST 2 distinct members, emit:
- "aspect": a short snake_case slug;
- "proposition": ONE self-contained sentence enumerating ALL members the facts state, with dates where known, e.g. "Melanie's pets: a cat named Bailey and a dog adopted in June 2023.";
- "members": the numbers of the facts you aggregated.

Rules: enumerate ONLY what the facts state — never invent members; prefer completeness over brevity; at most 12 aggregates. Output strictly the JSON schema.`;

export interface AggregateRunResult {
  entities: number;
  aggregatesWritten: number;
  skipped: Array<{ entityId: string; reason: string }>;
}

interface FactRowLite {
  id: unknown;
  predicate: string;
  object: string;
  validFrom?: string | Date;
}

@Injectable()
export class AggregateComposerService {
  private readonly logger = new Logger(AggregateComposerService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    private readonly embedding: FactEmbeddingService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'AGGREGATE_COMPOSER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /** Compose aggregates for the top-`entities` fact-densest entities. */
  async run(
    companyId: string,
    opts: { entities?: number } = {},
  ): Promise<AggregateRunResult> {
    const entityCap = Math.min(Math.max(opts.entities ?? 12, 1), 50);
    const result: AggregateRunResult = {
      entities: 0,
      aggregatesWritten: 0,
      skipped: [],
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const [tops] = await db.query<
        [Array<{ entityId: unknown; n: number }>]
      >(
        `SELECT entityId, count() AS n FROM knowledge_fact
          WHERE status = 'active' AND source.recorder != $recorder
          GROUP BY entityId ORDER BY n DESC LIMIT $k`,
        { k: entityCap, recorder: AGGREGATE_RECORDER },
      );
      for (const top of tops ?? []) {
        const entityId = String(top.entityId);
        try {
          const written = await this.composeEntity(db, entityId);
          result.entities += 1;
          result.aggregatesWritten += written;
        } catch (e) {
          result.skipped.push({ entityId, reason: (e as Error).message });
          this.logger.warn(
            `aggregate compose failed for ${entityId}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  private async composeEntity(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    entityId: string,
  ): Promise<number> {
    const [[entity]] = await db.query<[Array<{ canonicalName?: string }>]>(
      `SELECT canonicalName FROM $eid`,
      { eid: new StringRecordId(entityId) },
    );
    const name = entity?.canonicalName ?? entityId;
    const [facts] = await db.query<[FactRowLite[]]>(
      `SELECT id, predicate, object, validFrom FROM knowledge_fact
        WHERE entityId = $eid AND status = 'active'
          AND source.recorder != $recorder
        ORDER BY validFrom ASC LIMIT 400`,
      { eid: new StringRecordId(entityId), recorder: AGGREGATE_RECORDER },
    );
    if (!facts || facts.length < 4) return 0;

    const lines = facts.map(
      (f, i) =>
        `${i}. ${f.predicate}: ${f.object} (${String(f.validFrom ?? '').slice(0, 10)})`,
    );
    const aggregates = await this.callComposer(name, lines);
    const valid = aggregates.filter(
      (a) =>
        a.members.length >= 2 &&
        a.members.every((m) => m >= 0 && m < facts.length) &&
        a.proposition.trim().length > 0,
    );
    // Wholesale replace: aggregates are derived state, a re-run owns them.
    await db.query(
      `DELETE knowledge_fact
        WHERE entityId = $eid AND source.recorder = $recorder`,
      { eid: new StringRecordId(entityId), recorder: AGGREGATE_RECORDER },
    );
    if (valid.length === 0) return 0;

    const vectors = await this.embedding.embedMany(
      valid.map((a) => a.proposition),
    );
    for (const [i, agg] of valid.entries()) {
      const slug = agg.aspect
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .slice(0, 40);
      await db.query(
        `CREATE knowledge_fact CONTENT {
           entityId: $eid,
           predicate: $predicate,
           object: $object,
           confidence: 0.9,
           validFrom: time::now(),
           source: { vertical: 'aggregate', recorder: $recorder },
           status: 'active',
           embedding: $embedding,
           derivedFrom: $derivedFrom
         }`,
        {
          eid: new StringRecordId(entityId),
          predicate: `aggregate_${slug}`,
          object: agg.proposition,
          recorder: AGGREGATE_RECORDER,
          embedding: vectors[i],
          derivedFrom: agg.members.map(
            (m) => new StringRecordId(String(facts[m].id)),
          ),
        },
      );
    }
    return valid.length;
  }

  private async callComposer(
    name: string,
    factLines: string[],
  ): Promise<Array<{ aspect: string; proposition: string; members: number[] }>> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      max_completion_tokens: 1500,
      messages: [
        { role: 'system', content: COMPOSER_SYSTEM },
        {
          role: 'user',
          content: `Person: ${name}\n\nFacts:\n${factLines.join('\n')}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'aspect_aggregates',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              aggregates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    aspect: { type: 'string' },
                    proposition: { type: 'string' },
                    members: { type: 'array', items: { type: 'integer' } },
                  },
                  required: ['aspect', 'proposition', 'members'],
                },
              },
            },
            required: ['aggregates'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty composer response');
    const parsed = JSON.parse(content) as {
      aggregates?: Array<{
        aspect: string;
        proposition: string;
        members: number[];
      }>;
    };
    return Array.isArray(parsed.aggregates) ? parsed.aggregates : [];
  }
}
