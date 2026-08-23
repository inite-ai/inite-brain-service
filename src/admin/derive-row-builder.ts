import { resolveExtractionProfile } from '../ai/extraction-profile';
import { detectLanguage } from '../ai/locale/language-detector';
import { sourceTrustFor } from '../ingest/ingest-utils';
import { accumulateLanded, type RollupMember } from './aspect-rollups';
import { typedAtomKind, type DerivedProposition } from './deriver-client';
import { computeCharSpans } from './span-anchor';
import type { DeriveNamespace } from './derive-staging';
import type { EpisodeRow } from '../episodes/session-window';

/**
 * Stateless row construction for the window deriver, split from
 * window-deriver.service.ts for the god-file line budget (the staging
 * work of audit 2026-08-19 P1 pushed the service past 800): pure
 * functions of (propositions, session, namespace) — no service state.
 */

/** Row construction for one session's resolved propositions. */
export function buildDerivedRows({
  resolved,
  vectors,
  sessionDate,
  session,
  ns,
  conversationId,
}: {
  resolved: Array<{ p: DerivedProposition; entityId: string }>;
  vectors: number[][];
  sessionDate: Date;
  session: EpisodeRow[];
  ns: DeriveNamespace;
  conversationId: string;
}) {
  return resolved.map(({ p, entityId: subjectEntity }, i) => {
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
        : p.dateCleared
          ? // Audit-cleared → epoch sentinel (the read path's
            // "undated"); sessionDate would re-stamp the removed value.
            new Date(0)
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
      resolveExtractionProfile().deriveMentionStamp && firstTurn !== undefined
        ? {
            mentionedAt: new Date(
              session[firstTurn]!.occurredAt as string, // firstTurn < session.length
            ).toISOString(),
            turnIndex: firstTurn,
          }
        : {};
    // V13 scene trace: same FLEXIBLE-source ride as salience and
    // the mention stamp — capped so a runaway trace can't bloat
    // every prompt line it later renders on.
    const scene =
      resolveExtractionProfile().deriveSceneTrace && p.scene?.trim()
        ? { scene: p.scene.trim().slice(0, 200) }
        : {};
    // Release blocker (audit 2026-08-21 P0): the per-user scope of the
    // grounding turns must survive derivation — an episode ingested
    // under INGEST_EPISODE_ONLY with a userId used to derive into a
    // TENANT-GLOBAL fact, visible to every other user. Scope rule, per
    // proposition: grounded only in global turns → global fact;
    // grounded in exactly one user's turns (global turns may ride
    // along) → that user's fact; grounded in turns of TWO OR MORE
    // users → the row is poisoned for any single scope and must be
    // dropped (crossUserScope; the caller filters and warns).
    const groundingTurns = p.turns.filter(
      (t) => t >= 0 && t < session.length,
    );
    // Fail-closed (audit 2026-08-21 P0 round 2): a proposition with NO
    // turns, or with ANY out-of-range index, has unreliable grounding —
    // its scope cannot be trusted, so the row is dropped rather than
    // published tenant-global (groundingInvalid; the caller filters).
    const groundingInvalid =
      p.turns.length === 0 || groundingTurns.length !== p.turns.length;
    const scopeUsers = [
      ...new Set(
        groundingTurns
          .map((t) => session[t]!.userId) // t < session.length (filtered)
          .filter((u): u is string => typeof u === 'string' && u.length > 0),
      ),
    ];
    // G3 char-span provenance (DERIVER_SPANS): verify each deriver
    // quote mechanically against the turn text and stamp W3C-style
    // spans on the same FLEXIBLE-source ride as salience/scene.
    // INVARIANT: `session` rows are the STORED episode rows (already
    // PII-redacted by captureTurn before storage) — the deriver's
    // transcript, this anchoring, and the provenance API all read the
    // same stored text, so offsets stay valid end-to-end. A quote that
    // fails verification (absent/ambiguous) contributes no span; the
    // fact always lands (spans are optional enrichment, fail-safe).
    const charSpans =
      resolveExtractionProfile().deriveSpans && Array.isArray(p.quotes)
        ? computeCharSpans({ quotes: p.quotes, turns: p.turns, session })
        : [];
    // Provenance (recorder / trust) carries the FINAL version — it
    // survives the flip untouched; only derivedVersion is staged.
    const source = {
      vertical: 'derived',
      recorder: ns.final,
      conversationId,
      episodeIds: groundingTurns.map((t) => String(session[t]!.id)), // t < session.length
      ...salience,
      ...mention,
      ...scene,
      ...(charSpans.length > 0 ? { charSpans } : {}),
      // Multiworld §10: on-contract kinds only (off-enum → untyped).
      ...typedAtomKind(p),
    };
    return {
      userId: scopeUsers.length === 1 ? scopeUsers[0] : undefined,
      crossUserScope: scopeUsers.length > 1,
      groundingInvalid,
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
        recorder: ns.final,
      }),
      embedding: vectors[i]!, // vectors is 1:1 with resolved ⇒ in-bounds
      derivedVersion: ns.staging,
    };
  });
}

/**
 * Fold this session's LANDED rows into the conversation rollup pool.
 * dated = the row carries a REAL event date (not the session
 * fallback, not the cleared sentinel) — the composer only prints
 * date stamps for these; episodeIds ride along so the rollup keeps
 * provenance the excerpt lane can follow.
 */
export function collectRollupPool({
  rollupPool,
  resolved,
  rows,
  outcomes,
}: {
  rollupPool: RollupMember[];
  resolved: Array<{ p: DerivedProposition }>;
  rows: Array<{
    entityId: string;
    predicate: string;
    object: string;
    validFrom: Date;
    source?: { episodeIds?: unknown };
  }>;
  outcomes: Array<{ outcome: string }>;
}): void {
  const meta = resolved.map(({ p }) => {
    const occ =
      p.occurred_on && /^\d{4}-\d{2}-\d{2}$/.test(p.occurred_on)
        ? new Date(`${p.occurred_on}T00:00:00.000Z`)
        : null;
    return {
      dated:
        !!occ &&
        !Number.isNaN(occ.getTime()) &&
        occ.toISOString().slice(0, 10) === p.occurred_on,
    };
  });
  accumulateLanded(rollupPool, rows, { outcomes, meta });
}
