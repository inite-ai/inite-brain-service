import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StringRecordId, type Surreal } from 'surrealdb';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { AGGREGATE_RECORDER } from './aggregate-composer.service';

/**
 * Observations v2 composer (V9 §3): per-entity TOPIC ARCS.
 *
 * The insight SLOT is merged and pays (+10pp BEAM summarization); the
 * CONTENT is weak — aspect aggregates are attribute rollups ("pets: a
 * cat and a dog"), while the leaders' observations are topic ARCS
 * ("started planning the move in March, chose Austin in May, signed
 * the lease in June"). Progressive-summary golds want exactly that
 * dated narrative shape.
 *
 * This composer clusters an entity's dated facts into TOPICS — concrete
 * projects, plans, storylines, not attribute classes — and writes ONE
 * dated chronological narrative per topic as a `summary_arc_*`
 * knowledge_fact. The predicate prefix is the type system: arcs ride
 * the existing insight pool filter (`summary_*`), the insight budget
 * slot, and the summary/enumeration dispatch with ZERO read-path
 * changes; the fact legs already exclude them under
 * insightEvidence='routed'.
 *
 * Same write discipline as the aggregate composer: synthetic derived
 * rows, deliberately NOT routed through fn::resolve_fact; a re-run
 * replaces arcs wholesale (delete-by-recorder + insert in one atomic
 * transaction; every paid call happens before the swap).
 */
export const ARC_RECORDER = 'arc-composer-v1';

/** Keep the narrative inside the insight lane's 800-char prompt budget
 *  (insight-leg truncates at 800 — an arc cut mid-beat is worse than a
 *  shorter arc). The prompt asks for ≤600; this is the hard stop. */
const ARC_NARRATIVE_CHAR_CAP = 780;

const ARC_SYSTEM = `You build TOPIC-ARC memory summaries for one person from their dated atomic facts.

Cluster the facts into TOPICS — concrete projects, plans, storylines, or recurring pursuits (examples: apartment_move, marathon_training, job_search, novel_writing, garden_project). A topic is something that DEVELOPS over time, NOT an attribute class like "pets" or "hobbies".

For each topic supported by AT LEAST 2 facts spanning AT LEAST 2 different dates, emit:
- "topic": a short snake_case slug;
- "narrative": ONE chronological dated narrative of at most 600 characters, each development anchored to its date, e.g. "Started planning the move in March 2024; chose Austin over Denver in May; signed the lease on June 12 and scheduled the movers for July." Cover the arc from its first mention to its latest state;
- "members": the numbers of the facts the narrative is built from.

Rules: state ONLY what the facts state — never invent developments or dates; take dates from the fact date stamps; order every narrative chronologically; prefer few well-supported arcs over many thin ones; at most 8 arcs. Output strictly the JSON schema.`;

export interface ArcRunResult {
  entities: number;
  arcsWritten: number;
  skipped: Array<{ entityId: string; reason: string }>;
}

interface FactRowLite {
  id: unknown;
  predicate: string;
  object: string;
  validFrom?: string | Date;
}

interface ArcProposal {
  topic: string;
  narrative: string;
  members: number[];
}

/**
 * Arc validity: ≥2 in-range members whose facts span ≥2 distinct
 * dates (an arc needs a timeline — same-day beats are an aggregate,
 * not an arc), non-empty narrative. Exported for the unit spec.
 */
export function validArc(arc: ArcProposal, facts: FactRowLite[]): boolean {
  if (arc.members.length < 2) return false;
  if (!arc.members.every((m) => m >= 0 && m < facts.length)) return false;
  if (arc.narrative.trim().length === 0) return false;
  const days = new Set(
    arc.members.map((m) => String(facts[m].validFrom ?? '').slice(0, 10)),
  );
  return days.size >= 2;
}

/** Latest member validFrom — the arc is current as of its last beat. */
export function arcValidFrom(arc: ArcProposal, facts: FactRowLite[]): Date {
  let best = 0;
  for (const m of arc.members) {
    const t = new Date(String(facts[m]?.validFrom ?? 0)).getTime();
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best > 0 ? new Date(best) : new Date();
}

@Injectable()
export class ArcComposerService {
  private readonly logger = new Logger(ArcComposerService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    private readonly embedding: FactEmbeddingService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'ARC_COMPOSER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Compose topic arcs for the top-`entities` fact-densest entities of
   * the given derived namespace (same version semantics as the
   * aggregate composer — a pinned world must be stamped to be seen).
   */
  async run(
    companyId: string,
    opts: { entities?: number; version?: string } = {},
  ): Promise<ArcRunResult> {
    const entityCap = Math.min(Math.max(opts.entities ?? 12, 1), 50);
    const version = opts.version?.trim() || undefined;
    const versionClause = version
      ? 'AND derivedVersion = $version'
      : 'AND derivedVersion IS NONE';
    const result: ArcRunResult = { entities: 0, arcsWritten: 0, skipped: [] };
    await this.surreal.withCompany(companyId, async (db) => {
      const [tops] = await db.query<[Array<{ entityId: unknown; n: number }>]>(
        `SELECT entityId, count() AS n FROM knowledge_fact
          WHERE status = 'active'
            AND source.recorder != $recorder
            AND source.recorder != $aggRecorder
            AND !string::starts_with(predicate, 'summary_')
            ${versionClause}
          GROUP BY entityId ORDER BY n DESC LIMIT $k`,
        {
          k: entityCap,
          recorder: ARC_RECORDER,
          aggRecorder: AGGREGATE_RECORDER,
          version,
        },
      );
      for (const top of tops ?? []) {
        const entityId = String(top.entityId);
        try {
          const written = await this.composeEntity(db, entityId, version);
          result.entities += 1;
          result.arcsWritten += written;
        } catch (e) {
          result.skipped.push({ entityId, reason: (e as Error).message });
          this.logger.warn(
            `arc compose failed for ${entityId}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  private async composeEntity(
    db: {
      query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
    },
    entityId: string,
    version?: string,
  ): Promise<number> {
    const versionClause = version
      ? 'AND derivedVersion = $version'
      : 'AND derivedVersion IS NONE';
    const [[entity]] = await db.query<[Array<{ canonicalName?: string }>]>(
      `SELECT canonicalName FROM $eid`,
      { eid: new StringRecordId(entityId) },
    );
    const name = entity?.canonicalName ?? entityId;
    // Sources are the entity's ATOMIC dated facts: the composer's own
    // arcs and the aggregate composer's rollups are both derived state
    // and must never feed a re-run (self-ingestion inflates arcs with
    // their own summaries).
    const [facts] = await db.query<[FactRowLite[]]>(
      `SELECT id, predicate, object, validFrom FROM knowledge_fact
        WHERE entityId = $eid AND status = 'active'
          AND source.recorder != $recorder
          AND source.recorder != $aggRecorder
          AND !string::starts_with(predicate, 'summary_')
          ${versionClause}
        ORDER BY validFrom ASC LIMIT 400`,
      {
        eid: new StringRecordId(entityId),
        recorder: ARC_RECORDER,
        aggRecorder: AGGREGATE_RECORDER,
        version,
      },
    );
    if (!facts || facts.length < 4) return 0;

    const lines = facts.map(
      (f, i) =>
        `${i}. ${f.predicate}: ${f.object} (${String(f.validFrom ?? '').slice(0, 10)})`,
    );
    const arcs = await this.callComposer(name, lines);
    const valid = arcs.filter((a) => validArc(a, facts));
    // Every paid step (LLM above, embeddings here) runs BEFORE the
    // delete — a failure leaves the previous arcs intact.
    const vectors =
      valid.length > 0
        ? await this.embedding.embedMany(
            valid.map((a) => a.narrative.slice(0, ARC_NARRATIVE_CHAR_CAP)),
          )
        : [];
    const rows = valid.map((arc, i) => {
      const slug = arc.topic
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .slice(0, 28);
      return {
        entityId: new StringRecordId(entityId),
        predicate: `summary_arc_${slug}`,
        object: arc.narrative.slice(0, ARC_NARRATIVE_CHAR_CAP),
        confidence: 0.9,
        validFrom: arcValidFrom(arc, facts),
        source: { vertical: 'arc', recorder: ARC_RECORDER },
        status: 'active',
        embedding: vectors[i],
        derivedFrom: arc.members.map(
          (m) => new StringRecordId(String(facts[m].id)),
        ),
        ...(version ? { derivedVersion: version } : {}),
      };
    });
    // Wholesale replace — same atomic-swap discipline as the aggregate
    // composer: a retrieval landing mid-rerun sees the previous arc set
    // or the new one, never an entity stripped of its arcs.
    await runTransaction(db as unknown as Surreal, (tx) => {
      tx.add(
        `DELETE knowledge_fact
          WHERE entityId = $eid AND source.recorder = $recorder
            ${versionClause}`,
      );
      if (rows.length > 0) tx.add(`INSERT INTO knowledge_fact $rows`);
      tx.bind('eid', new StringRecordId(entityId))
        .bind('recorder', ARC_RECORDER)
        .bind('version', version)
        .bind('rows', rows);
    });
    return valid.length;
  }

  private async callComposer(
    name: string,
    factLines: string[],
  ): Promise<ArcProposal[]> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: ARC_SYSTEM },
        {
          role: 'user',
          content: `Person: ${name}\n\nFacts:\n${factLines.join('\n')}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'topic_arcs',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              arcs: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    topic: { type: 'string' },
                    narrative: { type: 'string' },
                    members: { type: 'array', items: { type: 'integer' } },
                  },
                  required: ['topic', 'narrative', 'members'],
                },
              },
            },
            required: ['arcs'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty arc composer response');
    const parsed = JSON.parse(content) as { arcs?: ArcProposal[] };
    return Array.isArray(parsed.arcs) ? parsed.arcs : [];
  }
}
