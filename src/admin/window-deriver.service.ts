import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { resolveExtractionProfile } from '../ai/extraction-profile';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { FactResolverService } from '../ingest/fact-resolver.service';
import { detectLanguage } from '../ai/locale/language-detector';
import { sourceTrustFor } from '../ingest/ingest-utils';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import { ReadPinService } from '../episodes/read-pin.service';

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

// The prompts + LLM-call cluster moved to deriver-client.ts (V10.5
// audit pass — same seam as generator-client on the synthesize side);
// re-exported so existing consumers keep their import.
export {
  DERIVER_ASSISTANT_SECTION,
  DERIVER_COMPLETION_PROMPT,
  SALIENCE_GRADING_SYSTEM,
  buildDeriverSystem,
  propositionKey,
} from './deriver-client';
import {
  callDeriver,
  foldDigest,
  type DerivedProposition,
} from './deriver-client';
import {
  accumulateLanded,
  composeAspectRollups,
  type RollupMember,
} from './aspect-rollups';

export type DeriveRunStatus = 'ok' | 'degraded' | 'failed';

export interface DeriveRunResult {
  conversations: number;
  sessions: number;
  propositions: number;
  unresolvedSubjects: number;
  skipped: Array<{ conversationId: string; reason: string }>;
  /**
   * 'ok' — every targeted conversation derived; 'degraded' — some failed
   * (skipped carries the reasons); 'failed' — at least one conversation
   * was attempted and none succeeded. A silent success on a failed derive
   * is how a poisoned eval row is born — callers must check this field.
   */
  status: DeriveRunStatus;
  /** Mirror of skipped.length, for callers that only read counters. */
  failed: number;
  /** Set when opts.activate flipped the live read pin to this version. */
  activated?: boolean;
  previousVersion?: string | null;
}

// The session primitive moved to the episodes layer (V9 quality pass —
// synthesize-side lanes need the same convention and may not import
// from admin); re-exported so existing consumers keep their import.
export {
  segmentSessions,
  type EpisodeRow,
} from '../episodes/session-window';
import { segmentSessions, type EpisodeRow } from '../episodes/session-window';

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
    private readonly factResolver: FactResolverService,
    @Optional() private readonly registry?: ProjectionRegistryService,
    @Optional() private readonly readPin?: ReadPinService,
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
    // The guard compares against THIS TENANT's live world (registry),
    // not the pod's env — a pod whose env still said wd-v2 used to pass
    // the guard and delete-by-version the world another pod served.
    const activePin =
      (await this.readPin?.resolve(companyId)) ??
      ReadPinService.bootstrapDefault() ??
      undefined;
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
      status: 'ok',
      failed: 0,
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
    // A run where every attempted conversation failed produced NOTHING —
    // marking it built/live would let gc protect a hollow world and let
    // eval drivers QA an empty substrate as if it were legitimate.
    if (this.finalizeRunStatus(result) === 'failed') {
      await this.registry?.fail({ companyId, name: 'facts', version });
      this.logger.error(
        `derive '${version}' failed for ${companyId}: all ` +
          `${result.failed} conversation(s) failed — first reason: ` +
          `${result.skipped[0]?.reason}`,
      );
      return result;
    }
    await this.maybeActivate({
      companyId,
      version,
      activate: opts.activate === true,
      activePin,
      result,
    });
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
    // Readers cache the pin briefly; an activation must land at once.
    if (result.activated) this.readPin?.invalidate(companyId);
    return result;
  }

  /**
   * Atomic world flip: readers switch from the old fork to the new one
   * between requests, never mid-build. The flip is a REGISTRY write
   * (run()'s complete({live:true}) marks this version live and demotes
   * the previous one) — audit W2 #9 removed the env-var mutation
   * that made a per-tenant activation repoint every tenant on the pod
   * and stay invisible to every other pod. Activation additionally
   * requires a CLEAN run: flipping every reader onto a world with known
   * holes is never what the operator meant.
   */
  private async maybeActivate(args: {
    companyId: string;
    version: string;
    activate: boolean;
    activePin: string | undefined;
    result: DeriveRunResult;
  }): Promise<void> {
    const { companyId, version, activate, activePin, result } = args;
    if (activate && result.conversations > 0 && result.failed === 0) {
      result.previousVersion =
        (await this.readPin?.resolve(companyId)) ?? activePin ?? null;
      result.activated = true;
      this.logger.log(
        `derived world '${version}' activated for ${companyId} ` +
          `(was: ${result.previousVersion ?? 'legacy'})`,
      );
    } else if (activate && result.failed > 0) {
      this.logger.warn(
        `activation of '${version}' refused for ${companyId}: ` +
          `${result.failed} of ${result.conversations + result.failed} ` +
          `conversation(s) failed — re-derive the failures, then activate`,
      );
    }
  }

  /**
   * Stamp status/failed from the skipped ledger: 'ok' — clean; 'degraded'
   * — partial; 'failed' — attempted and nothing succeeded (the V2
   * quota-poison shape).
   */
  private finalizeRunStatus(result: DeriveRunResult): DeriveRunStatus {
    result.failed = result.skipped.length;
    result.status =
      result.failed === 0
        ? 'ok'
        : result.conversations > 0
          ? 'degraded'
          : 'failed';
    return result.status;
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
    const activePin =
      (await this.readPin?.resolve(companyId)) ??
      ReadPinService.bootstrapDefault() ??
      undefined;
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

    // Re-runs own the namespace per conversation. Under slot semantics
    // a doomed row may have SUPERSEDED a row of another conversation
    // (entities span conversations) — deleting it would strand that
    // loser closed forever with supersededBy → a dead id, and the
    // re-derived rows would resolve against an empty slot (audit F2).
    // Revive such losers first (the 0014 sentinel shape: validUntil
    // restored from priorValidUntil, no retractedAt was ever set), so
    // the fresh derive re-arbitrates them normally. Matches 0 rows in
    // no-lifecycle worlds — safe to run unconditionally.
    await db.query(
      `UPDATE knowledge_fact SET
          status = 'active',
          supersededBy = NONE,
          validUntil = priorValidUntil,
          priorValidUntil = NONE,
          retractionReason = NONE,
          retractedBy = NONE
        WHERE derivedVersion = $version
          AND status = 'superseded'
          AND source.conversationId != $conv
          AND supersededBy IN (
            SELECT VALUE id FROM knowledge_fact
             WHERE derivedVersion = $version
               AND source.conversationId = $conv);
       DELETE knowledge_fact
        WHERE derivedVersion = $version AND source.conversationId = $conv`,
      { version, conv: conversationId },
    );

    // V12 §2 rolling digest: fold sessions chronologically into one
    // bounded narrative (the graphiti saga port). '' accumulates only
    // under the flag; null = off, zero extra calls.
    let digest = resolveExtractionProfile().deriveDigest ? '' : null;
    let digestEventAt: Date | null = null;
    // V13 A2: landed rows accumulate per conversation for the aspect
    // rollup pass ([] only under the flag — zero cost off).
    const rollupPool: RollupMember[] | null = resolveExtractionProfile()
      .deriveAspectRollups
      ? []
      : null;
    for (const session of segmentSessions(episodes)) {
      const sessionDate = new Date(session[0].occurredAt as string);
      const transcript = session.map(
        (e, i) => `[${i}] ${e.speaker ?? 'unknown'}: ${e.text}`,
      );
      if (digest !== null) {
        digest = await this.foldDigest(digest, sessionDate, transcript);
        const last = new Date(
          session[session.length - 1].occurredAt as string,
        );
        if (!digestEventAt || last > digestEventAt) digestEventAt = last;
      }
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
      // ONE write primitive for every producer (S4/0079): the batch
      // routes through fn::resolve_facts with the derivedVersion
      // namespace — still one round-trip per session, but the resolver
      // stamps the trust snapshot, locale and status instead of a raw
      // INSERT hand-copying its contract.
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
        const det = detectLanguage(p.proposition);
        const lang = det.language !== 'und' ? det.language : undefined;
        const script = det.language !== 'und' ? det.script : undefined;
        // V8 §4: salience rides in `source` (object FLEXIBLE, passed
        // verbatim through fn::resolve_fact's CREATE) — no schema
        // migration, no resolver-arity change; every read leg already
        // projects `source`. Only a valid 0-3 integer is stamped;
        // absent reads as neutral on the scoring side.
        const salience =
          resolveExtractionProfile().deriveSalienceStamp &&
          Number.isInteger(p.salience) &&
          (p.salience as number) >= 0 &&
          (p.salience as number) <= 3
            ? { salience: p.salience }
            : {};
        // V12 §1 (graphiti reference_time port): anchor the fact to
        // the event time of its FIRST grounding turn, with the
        // within-session ordinal for tie-breaks — mention order
        // becomes recoverable from facts. Same FLEXIBLE-source ride
        // as salience: no migration, no resolver-arity change.
        const firstTurn = p.turns.find((t) => t >= 0 && t < session.length);
        const mention =
          resolveExtractionProfile().deriveMentionStamp &&
          firstTurn !== undefined
            ? {
                mentionedAt: new Date(
                  session[firstTurn].occurredAt as string,
                ).toISOString(),
                turnIndex: firstTurn,
              }
            : {};
        const source = {
          vertical: 'derived',
          recorder: version,
          conversationId,
          episodeIds: p.turns
            .filter((t) => t >= 0 && t < session.length)
            .map((t) => String(session[t].id)),
          ...salience,
          ...mention,
        };
        return {
          entityId: subjectEntity,
          predicate: aspect || 'other',
          object: p.proposition,
          confidence: 0.85,
          lang,
          script,
          validFrom,
          source,
          sourceTrust: sourceTrustFor({
            vertical: 'derived',
            recorder: version,
          }),
          embedding: vectors[i],
          derivedVersion: version,
        };
      });
      // V9 §1: value-bearing aspects take the bitemporal_event
      // lifecycle when the profile asks; V9 phase 0: the resolver
      // batch degrades per-row instead of failing the conversation —
      // rows that landed nothing (SKIPPED = poisoned row, REJECTED =
      // low_score / create_returned_none) are not propositions.
      const outcomes = await this.factResolver.resolveDerivedBatch(db, rows, {
        slotSemantics: resolveExtractionProfile().deriveSlotSemantics,
      });
      const unlandedRows = outcomes.filter(
        (o) => o.outcome === 'SKIPPED' || o.outcome === 'REJECTED',
      ).length;
      result.propositions += rows.length - unlandedRows;
      if (rollupPool) accumulateLanded(rollupPool, rows, outcomes);
    }
    await this.persistDigest({ db, conversationId, version, digest, digestEventAt });
    if (rollupPool && rollupPool.length > 0) {
      await this.writeAspectRollups({
        db,
        conversationId,
        version,
        pool: rollupPool,
        result,
      });
    }
  }

  /**
   * Persist the digest AFTER the fold loop: replace-per-namespace
   * (derived state, rebuilt with the conversation on re-derive).
   * lastIngestAt = fold wall-clock (monotonic filter watermark for a
   * future incremental path); lastEventAt = max folded occurredAt.
   */
  private async persistDigest({
    db,
    conversationId,
    version,
    digest,
    digestEventAt,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    version: string;
    digest: string | null;
    digestEventAt: Date | null;
  }): Promise<void> {
    if (digest === null || !digest.trim() || !digestEventAt) return;
    await db.query(
      `DELETE conversation_digest
        WHERE conversationId = $conv AND derivedVersion = $version;
       CREATE conversation_digest SET
         conversationId = $conv, derivedVersion = $version,
         summary = $summary, lastIngestAt = time::now(),
         lastEventAt = <datetime>$eventAt`,
      {
        conv: conversationId,
        version,
        summary: digest,
        eventAt: digestEventAt.toISOString(),
      },
    );
  }

  /**
   * V13 A2 aspect rollups: mechanical per-(entity, aspect) list-facts
   * over this conversation's landed rows (see aspect-rollups.ts for
   * the composition contract). Written through the same resolver
   * batch as every derived row; failure degrades to a warning — the
   * atomic facts already landed.
   */
  private async writeAspectRollups({
    db,
    conversationId,
    version,
    pool,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    version: string;
    pool: RollupMember[];
    result: DeriveRunResult;
  }): Promise<void> {
    try {
      const rollups = composeAspectRollups(pool);
      if (rollups.length === 0) return;
      const vectors = await this.embedding.embedMany(
        rollups.map((r) => r.object),
      );
      const rows = rollups.map((r, i) => ({
        entityId: r.entityId,
        predicate: r.predicate,
        object: r.object,
        confidence: 0.85,
        validFrom: r.validFrom,
        source: {
          vertical: 'derived',
          recorder: version,
          conversationId,
          rollup: true,
          memberCount: r.memberCount,
        },
        sourceTrust: sourceTrustFor({
          vertical: 'derived',
          recorder: version,
        }),
        embedding: vectors[i],
        derivedVersion: version,
      }));
      const outcomes = await this.factResolver.resolveDerivedBatch(db, rows, {
        slotSemantics: false,
      });
      const landed = outcomes.filter(
        (o) => o.outcome !== 'SKIPPED' && o.outcome !== 'REJECTED',
      ).length;
      result.propositions += landed;
      this.logger.log(
        `aspect rollups: ${landed}/${rollups.length} landed (${conversationId})`,
      );
    } catch (e) {
      this.logger.warn(
        `aspect rollup pass failed (${(e as Error).message}) — atomic facts unaffected`,
      );
    }
  }

  // Thin adapter over the deriver client (V10.5 audit pass) — the
  // service supplies its openai/model/logger, the module owns the
  // prompts, pass/retry mechanics, completion union and grading turn.
  private async callDeriver(
    sessionDate: Date,
    participants: string[],
    transcript: string[],
  ): Promise<DerivedProposition[]> {
    return callDeriver(
      { openai: this.openai, model: this.model, logger: this.logger },
      { sessionDate, participants, transcript },
    );
  }

  private async foldDigest(
    existing: string,
    sessionDate: Date,
    transcript: string[],
  ): Promise<string> {
    return foldDigest(
      { openai: this.openai, model: this.model, logger: this.logger },
      { existing, sessionDate, transcript },
    );
  }
}
