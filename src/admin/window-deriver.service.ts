import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';

/**
 * Session-window deriver, P3 v1
 * (docs/roadmap/memory-substrate-redesign-2026-07.md §2.2-2.4).
 *
 * Re-derives memory from the L0 episode substrate one SESSION at a time
 * instead of one turn at a time. The window sees every turn, both
 * participants, and the session date — so it can do what the per-turn
 * extractor structurally cannot: resolve antecedents ("Luna and Oliver!"
 * as the answer to a question about pets), emit SELF-CONTAINED
 * propositions with resolved referents and absolute dates, and enumerate
 * list answers completely. Aspect slugs replace coined predicates; the
 * proposition text is the embedding basis, killing the question↔fragment
 * asymmetry by construction.
 *
 * v1 is a BATCH deriver for A/B measurement: it owns its
 * `derivedVersion` namespace wholesale (delete-by-version per
 * conversation, then create; no fn::resolve_fact), and the read path
 * switches worlds via RETRIEVAL_DERIVED_VERSION. Incremental prod
 * derivation (watermark tasks, diff-emission, version-scoped resolver)
 * is the P3-full follow-up.
 */
export const WINDOW_DERIVER_VERSION = 'wd-v2';
const SESSION_GAP_MS = 60 * 60 * 1000;

const DERIVER_SYSTEM = `You extract durable MEMORY PROPOSITIONS from ONE session of a two-person dialogue. The original conversation will NOT be available at retrieval time — each proposition must stand alone years later.

For every durable piece of information, emit:
- "subject": the full display name of the person the proposition is ABOUT (one of the participants, exactly as named);
- "aspect": one slug from: identity, residence, family, relationships, pets, activities, work, education, health, possessions, events, plans, preferences, media, travel, other;
- "proposition": ONE self-contained sentence. Resolve every pronoun and deictic reference ("it", "there", "she", "the kitty") to the concrete name or thing using the WHOLE session. Include absolute dates: resolve relative expressions ("last week", "next month") against the session date. Enumerate list answers completely ("X's pets are the cats Luna and Oliver and the dog Bailey"), never partially.
- "occurred_on": the ISO date (YYYY-MM-DD) the described event happened, when determinable, else null;
- "turns": the turn numbers this proposition is grounded in.

Rules: be exhaustive — a missed fact is worse than a redundant one; state ONLY what the session supports, never invent; skip pure smalltalk and pleasantries. Emit up to 40 propositions. Output strictly the JSON schema.`;

export interface DeriveRunResult {
  conversations: number;
  sessions: number;
  propositions: number;
  unresolvedSubjects: number;
  skipped: Array<{ conversationId: string; reason: string }>;
}

export interface EpisodeRow {
  id: unknown;
  speaker?: string;
  text: string;
  occurredAt: string | Date;
}

/** Pure: split time-ordered episodes into sessions by inactivity gap. */
export function segmentSessions(
  episodes: EpisodeRow[],
  gapMs: number = SESSION_GAP_MS,
): EpisodeRow[][] {
  const sessions: EpisodeRow[][] = [];
  let current: EpisodeRow[] = [];
  let prev: number | null = null;
  for (const ep of episodes) {
    const t = new Date(ep.occurredAt as string).getTime();
    if (prev !== null && t - prev > gapMs && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    current.push(ep);
    prev = t;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

interface DerivedProposition {
  subject: string;
  aspect: string;
  proposition: string;
  occurred_on: string | null;
  turns: number[];
}

@Injectable()
export class WindowDeriverService {
  private readonly logger = new Logger(WindowDeriverService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    private readonly embedding: FactEmbeddingService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'WINDOW_DERIVER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  async run(
    companyId: string,
    opts: { version?: string } = {},
  ): Promise<DeriveRunResult> {
    const version = opts.version ?? WINDOW_DERIVER_VERSION;
    const result: DeriveRunResult = {
      conversations: 0,
      sessions: 0,
      propositions: 0,
      unresolvedSubjects: 0,
      skipped: [],
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const [convs] = await db.query<
        [Array<{ conversationId?: string; n: number }>]
      >(
        `SELECT conversationId, count() AS n FROM episode
          WHERE conversationId IS NOT NONE
          GROUP BY conversationId`,
      );
      for (const conv of convs ?? []) {
        const conversationId = String(conv.conversationId);
        try {
          await this.deriveConversation({ db, conversationId, version, result });
          result.conversations += 1;
        } catch (e) {
          result.skipped.push({ conversationId, reason: (e as Error).message });
          this.logger.warn(
            `derive failed for ${conversationId}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  private async deriveConversation({
    db,
    conversationId,
    version,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    version: string;
    result: DeriveRunResult;
  }): Promise<void> {
    const [episodes] = await db.query<[EpisodeRow[]]>(
      `SELECT id, speaker, text, occurredAt FROM episode
        WHERE conversationId = $conv ORDER BY occurredAt ASC LIMIT 5000`,
      { conv: conversationId },
    );
    if (!episodes || episodes.length === 0) return;

    // Speaker display name → entity id, via the fact-densest entities
    // whose canonicalName embeds the speaker name. Unresolved subjects
    // are counted, not guessed.
    const speakers = [
      ...new Set(episodes.map((e) => e.speaker).filter((s): s is string => !!s)),
    ];
    // Deterministic first: LoCoMo-style speaker entities are canonically
    // `<convSlug>__<speaker>` where convSlug drops the vertical prefix
    // ("locomo:conv-26" → "conv_26"). Exact match sidesteps cross-
    // conversation name collisions ("John" in conv-41 AND conv-43) and
    // plain-name entity shadows. CONTAINS stays as the generic fallback.
    const convSlug = conversationId
      .slice(conversationId.lastIndexOf(':') + 1)
      .toLowerCase()
      .replace(/-/g, '_');
    const entityBySpeaker = new Map<string, string>();
    for (const sp of speakers) {
      const [exact] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_entity WHERE canonicalNameLc = $lc LIMIT 1`,
        { lc: `${convSlug}__${sp.toLowerCase()}` },
      );
      if (exact && exact.length === 1) {
        entityBySpeaker.set(sp.toLowerCase(), String(exact[0].id));
        continue;
      }
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_entity
          WHERE canonicalNameLc CONTAINS string::lowercase($name)
          LIMIT 2`,
        { name: sp },
      );
      if (rows && rows.length === 1) {
        entityBySpeaker.set(sp.toLowerCase(), String(rows[0].id));
      }
    }

    // Re-runs own the namespace per conversation.
    await db.query(
      `DELETE knowledge_fact
        WHERE derivedVersion = $version AND source.conversationId = $conv`,
      { version, conv: conversationId },
    );

    for (const session of segmentSessions(episodes)) {
      const sessionDate = new Date(session[0].occurredAt as string);
      const transcript = session.map(
        (e, i) => `[${i}] ${e.speaker ?? 'unknown'}: ${e.text}`,
      );
      const props = await this.callDeriver(
        sessionDate,
        speakers,
        transcript,
      );
      result.sessions += 1;
      // Subject → entity. Third-party subjects (kids, friends, another
      // conversation's cast) re-attach to the SPEAKER of their grounding
      // turn: retrieval matches the proposition text (which carries the
      // third party's name), so entity attribution only decides which
      // bucket presents it — dropping the proposition would be the real
      // loss. Only a fully unmappable proposition is skipped.
      const fallbackEntity = [...entityBySpeaker.values()][0];
      const resolved = props
        .map((p) => {
          const direct = entityBySpeaker.get(p.subject.toLowerCase());
          if (direct) return { p, entityId: direct };
          result.unresolvedSubjects += 1;
          const turn = p.turns.find((t) => t >= 0 && t < session.length);
          const viaSpeaker =
            turn !== undefined
              ? entityBySpeaker.get(
                  (session[turn].speaker ?? '').toLowerCase(),
                )
              : undefined;
          const entityId = viaSpeaker ?? fallbackEntity;
          return entityId ? { p, entityId } : null;
        })
        .filter((x): x is { p: DerivedProposition; entityId: string } => !!x);
      if (resolved.length === 0) continue;
      const vectors = await this.embedding.embedMany(
        resolved.map(({ p }) => p.proposition),
      );
      for (const [i, { p, entityId: subjectEntity }] of resolved.entries()) {
        const aspect = p.aspect
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .slice(0, 40);
        const validFrom =
          p.occurred_on && /^\d{4}-\d{2}-\d{2}$/.test(p.occurred_on)
            ? new Date(`${p.occurred_on}T00:00:00.000Z`)
            : sessionDate;
        await db.query(
          `CREATE knowledge_fact CONTENT {
             entityId: $eid,
             predicate: $predicate,
             object: $object,
             confidence: 0.85,
             validFrom: $validFrom,
             source: $source,
             status: 'active',
             embedding: $embedding,
             derivedVersion: $version
           }`,
          {
            eid: new StringRecordId(subjectEntity),
            predicate: aspect || 'other',
            object: p.proposition,
            validFrom,
            source: {
              vertical: 'derived',
              recorder: version,
              conversationId,
              episodeIds: p.turns
                .filter((t) => t >= 0 && t < session.length)
                .map((t) => String(session[t].id)),
            },
            embedding: vectors[i],
            version,
          },
        );
        result.propositions += 1;
      }
    }
  }

  private async callDeriver(
    sessionDate: Date,
    participants: string[],
    transcript: string[],
  ): Promise<DerivedProposition[]> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: DERIVER_SYSTEM },
        {
          role: 'user',
          content: `Session date: ${sessionDate.toISOString().slice(0, 10)}\nParticipants: ${participants.join(', ')}\n\nTranscript:\n${transcript.join('\n')}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'session_propositions',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              propositions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subject: { type: 'string' },
                    aspect: { type: 'string' },
                    proposition: { type: 'string' },
                    occurred_on: { type: ['string', 'null'] },
                    turns: { type: 'array', items: { type: 'integer' } },
                  },
                  required: [
                    'subject',
                    'aspect',
                    'proposition',
                    'occurred_on',
                    'turns',
                  ],
                },
              },
            },
            required: ['propositions'],
          },
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty deriver response');
    const parsed = JSON.parse(content) as {
      propositions?: DerivedProposition[];
    };
    return Array.isArray(parsed.propositions) ? parsed.propositions : [];
  }
}
