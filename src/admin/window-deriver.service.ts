import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { resolveExtractionProfile } from '../ai/extraction-profile';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { FactResolverService } from '../ingest/fact-resolver.service';
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
 * `derivedVersion` namespace wholesale and the read path switches
 * worlds via the registry pin (RETRIEVAL_DERIVED_VERSION as bootstrap).
 * Since audit 2026-08-19 P1 a run is ATOMIC: it builds the world in
 * `<version>.staging` under a per-(tenant, version) lease and a clean
 * run promotes it with one DELETE-then-UPDATE flip per table — see
 * derive-staging.ts. Incremental prod derivation (watermark tasks,
 * diff-emission) is the P3-full follow-up.
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
  composeCrossSession,
  foldDigest,
  type ComposedProposition,
  type DerivedProposition,
} from './deriver-client';
import {
  composeAspectRollups,
  majorityEntityId,
  type RollupMember,
} from './aspect-rollups';
import {
  STAGING_SUFFIX,
  acquireDeriveLease,
  promoteStaging,
  stagingNamespace,
  sweepStagingRows,
  type DeriveNamespace,
} from './derive-staging';
import { buildDerivedRows, collectRollupPool } from './derive-row-builder';
import { LeaderLeaseService } from '../jobs/leader-lease.service';

export type DeriveRunStatus = 'ok' | 'degraded' | 'failed';

export interface DeriveRunResult {
  conversations: number;
  sessions: number;
  propositions: number;
  /** Composed aspect-rollup rows (V13 A2) — separate from
   *  `propositions` so volume-parity gates keep comparing pure
   *  extraction volume across flag pairs. */
  rollups?: number;
  /** Cross-session composed rows (V13 DERIVER_COMPOSE_PASS) — same
   *  volume-parity reasoning as `rollups`. */
  composed?: number;
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
import {
  distinctUserScopes,
  segmentSessions,
  type EpisodeRow,
} from '../episodes/session-window';
import { persistDigest } from './digest-persist';

/** `YYYY-MM-DD HH:MM` (UTC) turn stamp for DERIVER_TURN_HEADERS. */
export function formatTurnStamp(occurredAt: string): string {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return occurredAt.slice(0, 16);
  return d.toISOString().slice(0, 16).replace('T', ' ');
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
    private readonly factResolver: FactResolverService,
    @Optional() private readonly registry?: ProjectionRegistryService,
    @Optional() private readonly readPin?: ReadPinService,
    @Optional() private readonly leaderLease?: LeaderLeaseService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'WINDOW_DERIVER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Derived worlds are FORKS, never in-place rewrites: derive into a
   * NEW version, then flip the pin (opts.activate); the old world stays
   * queryable as a residual until gc() reaps it. opts.force overrides
   * the guard for deliberate eval rewrites of an existing version —
   * under staging (audit 2026-08-19 P1) even a force run builds in
   * `<version>.staging` and replaces the old world atomically at the
   * flip, never in place mid-run.
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
    // The PRIMARY pin drives activation/live semantics below — a union
    // member is being read but is not the registry-live world.
    const activePin =
      (await this.readPin?.resolve(companyId)) ??
      ReadPinService.bootstrapDefault() ??
      undefined;
    // Audit 2026-08-21 P1: the guard covers the whole READ SET — a
    // union-served world (RETRIEVAL_DERIVED_VERSIONS) is as live as the
    // primary pin.
    if (ReadPinService.readSet(activePin).has(version) && !opts.force) {
      throw new Error(
        `version '${version}' is in the live read set — derive into a new ` +
          `version and flip the pin (activate: true), or pass force: true ` +
          `to rewrite the live world in place`,
      );
    }
    // Audit 2026-08-19 P1 (derive non-atomicity): every row lands in the
    // staging namespace, a clean run promotes it in one flip, and a
    // per-(tenant, version) lease makes a concurrent derive fail fast
    // instead of interleaving rows — see derive-staging.ts.
    const ns = stagingNamespace(version);
    const lease = await acquireDeriveLease({
      companyId,
      version,
      lease: this.leaderLease,
      logger: this.logger,
    });
    try {
      return await this.runStaged({ companyId, version, ns, opts, activePin });
    } finally {
      await lease.release();
    }
  }

  /** The lease-held body of run() — split so the lease acquire/release
   *  bracket stays visible at a glance in run() itself. */
  private async runStaged(args: {
    companyId: string;
    version: string;
    ns: DeriveNamespace;
    opts: { conversationId?: string; activate?: boolean };
    activePin: string | undefined;
  }): Promise<DeriveRunResult> {
    const { companyId, version, ns, opts, activePin } = args;
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
    // The row stays 'building' until the FLIP: 'built' must only ever
    // describe a fully promoted world.
    await this.registry?.begin({
      companyId,
      name: 'facts',
      version,
      builder: 'window-deriver',
    });
    try {
      await this.surreal.withCompany(companyId, async (db) => {
        // Orphaned staging rows of a PRIOR crashed run for this version:
        // the lease guarantees they have no live owner — sweep first.
        await sweepStagingRows(db, ns.staging);
        const convs = await this.episodes.conversationCounts(db);
        for (const conv of convs) {
          const conversationId = conv.conversationId;
          // Targeted re-derivation: one bad conversation should not force a
          // full-tenant (paid) re-run.
          if (opts.conversationId && conversationId !== opts.conversationId) {
            continue;
          }
          try {
            await this.deriveConversation({ db, conversationId, ns, result });
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
      await this.sweepStagingBestEffort(companyId, ns.staging);
      throw e;
    }
    // Only a CLEAN run is promoted. 'failed' produced nothing; 'degraded'
    // produced a world with known holes — under atomic-flip semantics
    // neither touches the final version (it stays byte-identical), the
    // partial staging world is swept, and the registry marks the attempt
    // failed. (Pre-staging behavior landed a degraded run's successful
    // conversations in place and marked the row 'built' — flipping every
    // reader onto a hole-y world is never what the operator meant.)
    if (this.finalizeRunStatus(result) !== 'ok') {
      await this.registry?.fail({ companyId, name: 'facts', version });
      await this.sweepStagingBestEffort(companyId, ns.staging);
      if (result.status === 'failed') {
        this.logger.error(
          `derive '${version}' failed for ${companyId}: all ` +
            `${result.failed} conversation(s) failed — first reason: ` +
            `${result.skipped[0]?.reason}`,
        );
      } else {
        this.logger.warn(
          `derive '${version}' degraded for ${companyId}: ${result.failed} ` +
            `conversation(s) failed — final version left untouched, staging ` +
            `swept${opts.activate ? '; activation refused' : ''} — re-derive ` +
            `the failures, then re-run`,
        );
      }
      return result;
    }
    // Atomic flip: staging → final (DELETE final + UPDATE staging, one
    // BEGIN/COMMIT per table). A run that attempted no conversation has
    // nothing to promote — flipping would wipe the final world with an
    // empty staging namespace.
    if (result.conversations > 0) {
      try {
        await this.surreal.withCompany(companyId, (db) =>
          promoteStaging(db, ns, { conversationId: opts.conversationId }),
        );
      } catch (e) {
        // Facts and digests flip in separate transactions; a failure
        // here can leave facts promoted with digests still staged. The
        // registry marks the world failed either way, and staging is
        // LEFT in place (forensics) — the next run for this version
        // sweeps it.
        await this.registry?.fail({ companyId, name: 'facts', version });
        throw e;
      }
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

  /** Failed/degraded-run staging GC — best-effort by contract: the next
   *  run for the same version sweeps whatever this pass missed. */
  private async sweepStagingBestEffort(
    companyId: string,
    staging: string,
  ): Promise<void> {
    try {
      await this.surreal.withCompany(companyId, (db) =>
        sweepStagingRows(db, staging),
      );
    } catch (e) {
      this.logger.warn(
        `staging sweep for '${staging}' failed (${(e as Error).message}) — ` +
          `the next derive for this version sweeps it`,
      );
    }
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
    // Audit 2026-08-21 P1: the whole READ SET survives GC — union
    // worlds are being served even when no registry row says so.
    const activePins = ReadPinService.readSet(
      (await this.readPin?.resolve(companyId)) ??
        ReadPinService.bootstrapDefault(),
    );
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
      [...activePins, ...registryKeep, ...(opts.keep ?? [])].filter(Boolean),
    );
    if (keep.size === 0) {
      throw new Error(
        'gc refused: no live read pin and no registry evidence of a ' +
          'surviving world — deleting every derived version is never the ' +
          'intent. Pass keep: [...] explicitly to override.',
      );
    }
    // A `<v>.staging` namespace belongs to an in-flight (or crashed)
    // derive of `<v>` — reap it only when its BASE version is reapable,
    // so gc can never yank the rows out from under a running derive
    // whose registry row says 'building'. Crash orphans die with their
    // base or at the start of the next run for that version.
    const kept = (name: string): boolean =>
      keep.has(name) ||
      (name.endsWith(STAGING_SUFFIX) &&
        keep.has(name.slice(0, -STAGING_SUFFIX.length)));
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
        if (kept(name)) continue;
        await db.query(
          `DELETE knowledge_fact WHERE derivedVersion = $version`,
          { version: name },
        );
        // Audit 2026-08-19 P1: the version's digests die with it — a
        // reaped world must not keep serving its narrative.
        await db.query(
          `DELETE conversation_digest WHERE derivedVersion = $version`,
          { version: name },
        );
        deleted[name] = v.n;
      }
      // Digests of versions with ZERO remaining facts (fold ran but the
      // fact write failed, or a version never landed facts) are
      // unreachable through any keep-set derived from facts — sweep the
      // orphans by the same keep-set.
      const [digestVersions] = await db.query<
        [Array<{ derivedVersion?: string }>]
      >(
        `SELECT derivedVersion FROM conversation_digest
          WHERE derivedVersion IS NOT NONE
          GROUP BY derivedVersion`,
      );
      for (const v of digestVersions ?? []) {
        const name = String(v.derivedVersion);
        if (kept(name) || name in deleted) continue;
        await db.query(
          `DELETE conversation_digest WHERE derivedVersion = $version`,
          { version: name },
        );
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
    ns,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    ns: DeriveNamespace;
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
    // the fresh derive re-arbitrates them normally. Under staging this
    // operates on `<version>.staging` — 0 rows on a fresh run (the
    // start-of-run sweep emptied it); kept for idempotence should a
    // conversation ever be derived twice within one run. The FINAL
    // world's revive-before-replace happens at flip time
    // (promoteStaging, targeted shape).
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
      { version: ns.staging, conv: conversationId },
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
    // V13 compose pass: same landed-row pool shape, separate flag —
    // the LLM composition and the mechanical rollups are independent
    // legs and must be measurable apart.
    const composePool: RollupMember[] | null = resolveExtractionProfile()
      .deriveComposePass
      ? []
      : null;
    // V13 DERIVER_TURN_HEADERS: each line carries the turn's own
    // timestamp so occurred_on resolves against the TURN, not the
    // session's first day. Off = the historical bare render.
    const turnHeaders = resolveExtractionProfile().deriveTurnHeaders;
    for (const session of segmentSessions(episodes)) {
      const sessionDate = new Date(session[0].occurredAt as string);
      const transcript = session.map((e, i) =>
        turnHeaders
          ? `[${i}] (${formatTurnStamp(e.occurredAt as string)}) ${e.speaker ?? 'unknown'}: ${e.text}`
          : `[${i}] ${e.speaker ?? 'unknown'}: ${e.text}`,
      );
      if (digest !== null) {
        // Degrade, never fail: the version-scoped DELETE already ran —
        // a fold error would strand the conversation with ZERO facts.
        try {
          digest = await this.foldDigest(digest, sessionDate, transcript);
        } catch (e) {
          this.logger.warn(
            `digest fold failed (${(e as Error).message}) — keeping prior digest state`,
          );
        }
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
      // V13 scene traces: the trace is part of the ENCODING — it folds
      // into the embedded text (that is the dual-trace mechanism: the
      // situational context makes the row findable from situational
      // questions), while the stored object stays the bare proposition.
      const vectors = await this.embedding.embedMany(
        resolved.map(({ p }) =>
          p.scene?.trim()
            ? `${p.proposition} — ${p.scene.trim()}`
            : p.proposition,
        ),
      );
      // ONE write primitive for every producer (S4/0079): the batch
      // routes through fn::resolve_facts with the derivedVersion
      // namespace — still one round-trip per session, but the resolver
      // stamps the trust snapshot, locale and status instead of a raw
      // INSERT hand-copying its contract.
      const rows = buildDerivedRows({
        resolved,
        vectors,
        sessionDate,
        session,
        ns,
        conversationId,
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
      if (rollupPool) {
        collectRollupPool({ rollupPool, resolved, rows, outcomes });
      }
      if (composePool) {
        collectRollupPool({ rollupPool: composePool, resolved, rows, outcomes });
      }
    }
    // 0087: the folded window's distinct user scopes = policy metadata.
    const userScopes = distinctUserScopes(episodes);
    await persistDigest({
      db,
      conversationId,
      version: ns.staging,
      digest,
      digestEventAt,
      userScopes,
    });
    await this.writeCompositionPasses({
      db,
      conversationId,
      ns,
      rollupPool,
      composePool,
      result,
    });
  }

  /** Post-session composition writes (rollups + compose pass), split
   *  from deriveConversation for the complexity gate. */
  private async writeCompositionPasses({
    db,
    conversationId,
    ns,
    rollupPool,
    composePool,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    ns: DeriveNamespace;
    rollupPool: RollupMember[] | null;
    composePool: RollupMember[] | null;
    result: DeriveRunResult;
  }): Promise<void> {
    if (rollupPool && rollupPool.length > 0) {
      await this.writeAspectRollups({
        db,
        conversationId,
        ns,
        pool: rollupPool,
        result,
      });
    }
    if (composePool && composePool.length >= 2) {
      await this.writeComposedFacts({
        db,
        conversationId,
        ns,
        pool: composePool,
        result,
      });
    }
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
    ns,
    pool,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    ns: DeriveNamespace;
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
          recorder: ns.final,
          conversationId,
          rollup: true,
          memberCount: r.memberCount,
          // Union of member grounding turns — the provenance/excerpt
          // lane filters on episodeIds IS NOT NONE; without it a
          // winning rollup silently yields zero quote lines.
          ...(r.episodeIds.length > 0 ? { episodeIds: r.episodeIds } : {}),
        },
        sourceTrust: sourceTrustFor({
          vertical: 'derived',
          recorder: ns.final,
        }),
        embedding: vectors[i],
        derivedVersion: ns.staging,
      }));
      const outcomes = await this.factResolver.resolveDerivedBatch(db, rows, {
        slotSemantics: false,
      });
      const landed = outcomes.filter(
        (o) => o.outcome !== 'SKIPPED' && o.outcome !== 'REJECTED',
      ).length;
      // Separate counter: result.propositions feeds the volume-parity
      // gates (percent-level comparisons across flag pairs) — folding
      // composed rows in would report inflated EXTRACTION volume.
      result.rollups = (result.rollups ?? 0) + landed;
      this.logger.log(
        `aspect rollups: ${landed}/${rollups.length} landed (${conversationId})`,
      );
    } catch (e) {
      this.logger.warn(
        `aspect rollup pass failed (${(e as Error).message}) — atomic facts unaffected`,
      );
    }
  }

  /**
   * V13 cross-session composition (DERIVER_COMPOSE_PASS, the PREMem
   * shape): one LLM call over this conversation's landed atoms emits
   * multi-atom compositions — the write-time answer to the measured
   * "every atom exists, no atom states the combination" multi-hop
   * class. Member indices are validated here (≥2 in-range members);
   * entity attribution and grounding union come FROM the members, so
   * a hallucinated member list cannot invent provenance. Failure
   * degrades to a warning — the atomic facts already landed.
   */
  private async writeComposedFacts({
    db,
    conversationId,
    ns,
    pool,
    result,
  }: {
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
    conversationId: string;
    ns: DeriveNamespace;
    pool: RollupMember[];
    result: DeriveRunResult;
  }): Promise<void> {
    try {
      const raw = await this.composeCrossSession(pool);
      // Audit 2026-08-19: dedupe member indices ([0,0] must not pass the
      // two-member floor) and demand two DISTINCT supporting atoms.
      const compositions = raw
        .map((c) => ({
          ...c,
          members: [
            ...new Set(
              c.members.filter(
                (m) => Number.isInteger(m) && m >= 0 && m < pool.length,
              ),
            ),
          ],
        }))
        .filter((c) => c.members.length >= 2 && c.proposition.trim());
      if (compositions.length === 0) return;
      const vectors = await this.embedding.embedMany(
        compositions.map((c) => c.proposition),
      );
      const rows = compositions.map((c, i) => {
        const members = c.members.map((m) => pool[m]);
        const aspect = c.aspect
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .slice(0, 40);
        const occurredMs = c.occurred_on
          ? Date.parse(`${c.occurred_on}T00:00:00.000Z`)
          : NaN;
        const validFrom = Number.isFinite(occurredMs)
          ? new Date(occurredMs)
          : new Date(
              Math.max(...members.map((m) => m.validFrom.getTime())),
            );
        const episodeIds = [
          ...new Set(members.flatMap((m) => m.episodeIds)),
        ].slice(0, 64);
        return {
          entityId: majorityEntityId(members),
          predicate: aspect || 'other',
          object: c.proposition,
          confidence: 0.85,
          validFrom,
          source: {
            vertical: 'derived',
            recorder: ns.final,
            conversationId,
            composed: true,
            memberCount: members.length,
            ...(episodeIds.length > 0 ? { episodeIds } : {}),
          },
          sourceTrust: sourceTrustFor({
            vertical: 'derived',
            recorder: ns.final,
          }),
          embedding: vectors[i],
          derivedVersion: ns.staging,
        };
      });
      const outcomes = await this.factResolver.resolveDerivedBatch(db, rows, {
        slotSemantics: false,
      });
      const landed = outcomes.filter(
        (o) => o.outcome !== 'SKIPPED' && o.outcome !== 'REJECTED',
      ).length;
      // Separate counter — same volume-parity reasoning as rollups.
      result.composed = (result.composed ?? 0) + landed;
      this.logger.log(
        `compose pass: ${landed}/${compositions.length} landed (${conversationId})`,
      );
    } catch (e) {
      this.logger.warn(
        `compose pass failed (${(e as Error).message}) — atomic facts unaffected`,
      );
    }
  }

  private async composeCrossSession(
    pool: RollupMember[],
  ): Promise<ComposedProposition[]> {
    return composeCrossSession(
      { openai: this.openai, model: this.model, logger: this.logger },
      {
        atoms: pool.map((m) => ({
          // Entity tag so the model never blends different people's
          // atoms into one composition (audit 2026-08-19).
          entity: m.entityId.split(':').pop()?.slice(0, 40) ?? m.entityId,
          predicate: m.predicate,
          object: m.object,
          dateIso: m.dated ? m.validFrom.toISOString().slice(0, 10) : null,
        })),
      },
    );
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
