import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { runInsightComposer, type InsightComposerSpec } from './insight-composer-kernel';

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
 * wholesale. Selection, error accounting, and the atomic swap live in
 * the shared insight-composer kernel; this service owns only the
 * aggregate identity — prompt, validity, row shape.
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

interface AggregateProposal {
  aspect: string;
  proposition: string;
  members: number[];
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

  private readonly spec: InsightComposerSpec<AggregateProposal> = {
    recorder: AGGREGATE_RECORDER,
    // Arcs (summary_arc_*) and promotion/compaction summaries are
    // derived state — excluded by the summary_ prefix idiom so a
    // re-run never aggregates another composer's summaries (V9 §3).
    sourceExclusionSql: `AND source.recorder != $recorder
          AND !string::starts_with(predicate, 'summary_')`,
    sourceExclusionParams: { recorder: AGGREGATE_RECORDER },
    minFacts: 4,
    propose: (name, lines) => this.callComposer(name, lines),
    valid: (a, facts) =>
      a.members.length >= 2 &&
      a.members.every((m) => m >= 0 && m < facts.length) &&
      a.proposition.trim().length > 0,
    embeddingTextOf: (a) => a.proposition,
    buildRow: (agg, ctx) => {
      const slug = agg.aspect
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .slice(0, 40);
      return {
        entityId: ctx.entityId,
        predicate: `aggregate_${slug}`,
        object: agg.proposition,
        confidence: 0.9,
        validFrom: new Date(),
        source: { vertical: 'aggregate', recorder: AGGREGATE_RECORDER },
        status: 'active',
        embedding: ctx.vector,
        derivedFrom: agg.members.map(
          // members are validated in-bounds by the `valid` predicate above.
          (m) => new StringRecordId(String(ctx.facts[m]!.id)),
        ),
        ...(ctx.version ? { derivedVersion: ctx.version } : {}),
      };
    },
  };

  /**
   * Compose aggregates for the top-`entities` fact-densest entities.
   * With `version` set (memory-rebuild R4), sources come from that
   * derived namespace and the aggregates are stamped with the same
   * `derivedVersion` — REQUIRED for a RETRIEVAL_DERIVED_VERSION-pinned
   * world to see them.
   */
  async run(
    companyId: string,
    opts: { entities?: number | undefined; version?: string | undefined } = {},
  ): Promise<AggregateRunResult> {
    const r = await runInsightComposer(
      { surreal: this.surreal, embedding: this.embedding, logger: this.logger },
      this.spec,
      { companyId, ...opts },
    );
    return {
      entities: r.entities,
      aggregatesWritten: r.written,
      skipped: r.skipped,
    };
  }

  private async callComposer(name: string, factLines: string[]): Promise<AggregateProposal[]> {
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
      aggregates?: AggregateProposal[];
    };
    return Array.isArray(parsed.aggregates) ? parsed.aggregates : [];
  }
}
