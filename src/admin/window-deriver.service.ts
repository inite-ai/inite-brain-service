import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { envFlagEnabled } from '../common/env-validation';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';

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

/**
 * E3a assistant-content section (DERIVER_ASSISTANT_CONTENT). The base
 * contract is user-fact-shaped ("the person the proposition is ABOUT"),
 * so substantive content the assistant CONTRIBUTED — recommendations,
 * answers, instructions — structurally never becomes a proposition.
 * That is the measured SSA failure ("facts do not specify…" while the
 * verbatim turn sits in L0) at the substrate level; the read-side
 * verbatim lane routes around it, this closes it at the source.
 * Flag-gated, default off: deriver prompt changes need a paid confirm
 * leg on a FRESH derivedVersion (worlds derived under different prompts
 * must not share a version).
 */
export const DERIVER_ASSISTANT_SECTION = `

ASSISTANT-SIDE CONTRIBUTIONS
Also emit propositions for substantive content a participant CONTRIBUTED to the other: recommendations made, answers and explanations given, instructions or steps provided, plans proposed. Use aspect "assistance", subject = the CONTRIBUTING participant, and state specifically WHAT was recommended/explained and to whom ("Assistant recommended the token-bucket algorithm to Alex for API rate limiting"). Keep the concrete payload — names, numbers, steps, code identifiers — because a later question will ask "what did you suggest…" and ONLY this proposition will be available to answer it.`;

/** System prompt assembly; the section only exists when the flag asks. */
export function buildDeriverSystem(opts?: {
  assistantContent?: boolean;
}): string {
  return (
    DERIVER_SYSTEM + (opts?.assistantContent ? DERIVER_ASSISTANT_SECTION : '')
  );
}

export interface DeriveRunResult {
  conversations: number;
  sessions: number;
  propositions: number;
  unresolvedSubjects: number;
  skipped: Array<{ conversationId: string; reason: string }>;
  /** Set when opts.activate flipped the live read pin to this version. */
  activated?: boolean;
  previousVersion?: string | null;
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

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    private readonly embedding: FactEmbeddingService,
    private readonly episodes: EpisodeReadStoreService,
    @Optional() private readonly registry?: ProjectionRegistryService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'WINDOW_DERIVER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Derived worlds are FORKS, never in-place rewrites: deriving into the
   * version readers are currently pinned to (RETRIEVAL_DERIVED_VERSION)
   * would expose them to a half-built world mid-run — delete-by-version
   * happens before the new rows land. Derive into a NEW version, then
   * flip the pin (opts.activate); the old world stays queryable as a
   * residual until gc() reaps it. opts.force overrides the guard for
   * deliberate in-place eval workflows.
   */
  async run(
    companyId: string,
    opts: {
      version?: string;
      conversationId?: string;
      activate?: boolean;
      force?: boolean;
    } = {},
  ): Promise<DeriveRunResult> {
    const version = opts.version ?? WINDOW_DERIVER_VERSION;
    const activePin = process.env.RETRIEVAL_DERIVED_VERSION?.trim();
    if (version === activePin && !opts.force) {
      throw new Error(
        `version '${version}' is the live read pin — derive into a new ` +
          `version and flip the pin (activate: true), or pass force: true ` +
          `to rewrite the live world in place`,
      );
    }
    const result: DeriveRunResult = {
      conversations: 0,
      sessions: 0,
      propositions: 0,
      unresolvedSubjects: 0,
      skipped: [],
    };
    // Registry (driver surface 3): observes the lifecycle, never fails it —
    // every registry write degrades to a warning inside the service.
    await this.registry?.begin({
      companyId,
      name: 'facts',
      version,
      builder: 'window-deriver',
    });
    try {
      await this.surreal.withCompany(companyId, async (db) => {
        const convs = await this.episodes.conversationCounts(db);
        for (const conv of convs) {
          const conversationId = conv.conversationId;
          // Targeted re-derivation: one bad conversation should not force a
          // full-tenant (paid) re-run.
          if (opts.conversationId && conversationId !== opts.conversationId) {
            continue;
          }
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
    } catch (e) {
      await this.registry?.fail({ companyId, name: 'facts', version });
      throw e;
    }
    // Atomic world flip: readers switch from the old fork to the new one
    // between requests, never mid-build. Process-local (env pin) — the
    // per-tenant DB pointer is the prod follow-up.
    if (opts.activate && result.conversations > 0) {
      result.previousVersion = process.env.RETRIEVAL_DERIVED_VERSION ?? null;
      process.env.RETRIEVAL_DERIVED_VERSION = version;
      result.activated = true;
      this.logger.log(
        `derived world '${version}' activated (was: ${result.previousVersion ?? 'legacy'})`,
      );
    }
    await this.registry?.complete({
      companyId,
      name: 'facts',
      version,
      live: result.activated === true || version === activePin,
      stats: {
        conversations: result.conversations,
        sessions: result.sessions,
        propositions: result.propositions,
        skipped: result.skipped.length,
      },
    });
    return result;
  }

  /**
   * Reap residual worlds: delete derived facts of every version that is
   * neither the live pin nor explicitly kept. The legacy namespace
   * (derivedVersion IS NONE) is never touched.
   */
  async gc(
    companyId: string,
    opts: { keep?: string[] } = {},
  ): Promise<{ deleted: Record<string, number>; kept: string[] }> {
    const activePin = process.env.RETRIEVAL_DERIVED_VERSION?.trim();
    // Audit W0 (engine-architecture-audit-2026-08.md #8): the registry is
    // part of the keep-set — the env pin is process-local and may be unset
    // on this pod while another pod serves a live world. live/building/
    // built rows all survive; an EMPTY keep-set aborts instead of deleting
    // every derived world in the tenant.
    const registryKeep = ((await this.registry?.list(companyId)) ?? [])
      .filter(
        (r) =>
          r.name === 'facts' &&
          (r.status === 'live' || r.status === 'building' || r.status === 'built'),
      )
      .map((r) => r.version);
    const keep = new Set(
      [activePin, ...registryKeep, ...(opts.keep ?? [])].filter(Boolean),
    );
    if (keep.size === 0) {
      throw new Error(
        'gc refused: no live read pin and no registry evidence of a ' +
          'surviving world — deleting every derived version is never the ' +
          'intent. Pass keep: [...] explicitly to override.',
      );
    }
    const deleted: Record<string, number> = {};
    await this.surreal.withCompany(companyId, async (db) => {
      const [versions] = await db.query<
        [Array<{ derivedVersion?: string; n: number }>]
      >(
        `SELECT derivedVersion, count() AS n FROM knowledge_fact
          WHERE derivedVersion IS NOT NONE
          GROUP BY derivedVersion`,
      );
      for (const v of versions ?? []) {
        const name = String(v.derivedVersion);
        if (keep.has(name)) continue;
        await db.query(
          `DELETE knowledge_fact WHERE derivedVersion = $version`,
          { version: name },
        );
        deleted[name] = v.n;
      }
    });
    // A registry row promises a queryable world — reaped versions lose theirs.
    await this.registry?.dropVersions({
      companyId,
      name: 'facts',
      versions: Object.keys(deleted),
    });
    return { deleted, kept: [...keep] as string[] };
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
    const episodes: EpisodeRow[] = await this.episodes.conversationTurns(
      db,
      conversationId,
    );
    if (episodes.length === 0) return;

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
    // All exact slugs in one round trip; CONTAINS stays as a per-speaker
    // fallback only for the (rare) names the exact pass missed.
    const slugBySpeaker = new Map<string, string>(
      speakers.map((sp) => [`${convSlug}__${sp.toLowerCase()}`, sp]),
    );
    const [exactRows] = await db.query<
      [Array<{ id: unknown; canonicalNameLc: string }>]
    >(
      `SELECT id, canonicalNameLc FROM knowledge_entity
        WHERE canonicalNameLc INSIDE $slugs`,
      { slugs: [...slugBySpeaker.keys()] },
    );
    for (const row of exactRows ?? []) {
      const sp = slugBySpeaker.get(row.canonicalNameLc);
      if (sp) entityBySpeaker.set(sp.toLowerCase(), String(row.id));
    }
    for (const sp of speakers) {
      if (entityBySpeaker.has(sp.toLowerCase())) continue;
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
      // One multi-row INSERT per session instead of a CREATE per
      // proposition — a 40-proposition session used to cost 40 round
      // trips (Surreal-usage audit §9).
      const rows = resolved.map(({ p, entityId: subjectEntity }, i) => {
        const aspect = p.aspect
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .slice(0, 40);
        // Regex alone admits impossible calendar dates the LLM sometimes
        // emits ("2023-02-30") — depending on the engine those parse to
        // Invalid Date (poisons the write; used to skip the whole
        // conversation) or silently roll over to another day. Round-trip
        // check accepts only real dates; anything else falls back to the
        // session date.
        const occurred =
          p.occurred_on && /^\d{4}-\d{2}-\d{2}$/.test(p.occurred_on)
            ? new Date(`${p.occurred_on}T00:00:00.000Z`)
            : null;
        const validFrom =
          occurred &&
          !Number.isNaN(occurred.getTime()) &&
          occurred.toISOString().slice(0, 10) === p.occurred_on
            ? occurred
            : sessionDate;
        return {
          entityId: new StringRecordId(subjectEntity),
          predicate: aspect || 'other',
          object: p.proposition,
          confidence: 0.85,
          validFrom,
          source: {
            vertical: 'derived',
            recorder: version,
            conversationId,
            episodeIds: p.turns
              .filter((t) => t >= 0 && t < session.length)
              .map((t) => String(session[t].id)),
          },
          status: 'active',
          embedding: vectors[i],
          derivedVersion: version,
        };
      });
      await db.query(`INSERT INTO knowledge_fact $rows`, { rows });
      result.propositions += rows.length;
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
        {
          role: 'system',
          content: buildDeriverSystem({
            assistantContent: envFlagEnabled(
              process.env.DERIVER_ASSISTANT_CONTENT,
            ),
          }),
        },
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
