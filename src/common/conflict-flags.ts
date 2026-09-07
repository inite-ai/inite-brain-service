import { envFlagEnabled } from './env-validation';

/**
 * Direct-fact conflict semantics — CONFLICT_DIRECT_FACT_SLOT.
 *
 * A predicate absent from the registry resolves to DEFAULT_FALLBACK
 * (`__default__`, semantics 'append_only') — correct for the
 * open-vocabulary mention bulk, but on the TYPED direct path
 * (record_fact / POST /v1/ingest/fact) it short-circuits
 * fn::resolve_fact's conflict pool to `[]`: two direct writes with the
 * same (entity, predicate) and contradicting objects both land
 * INSERTED and no conflict is ever formed or surfaced.
 *
 * When on, FactResolverService promotes JUST that combination — direct
 * path (recordOutcomeMetric) AND registry-default predicate — to
 * 'bitemporal': the margin doctrine, i.e. close-scored contradictions
 * become COMPETING and a clear winner SUPERSEDES. Deliberately NOT
 * 'single_active': its resolver branch supersedes unconditionally
 * (0085 `$supersede = $semantics = 'single_active' OR …`) and can
 * never surface a COMPETING pair. DEFAULT_FALLBACK itself is untouched
 * (load-bearing for mention extraction), as is every known predicate's
 * registry policy. The env read lives here in the common layer
 * (engine-gates S5.2), read at call time so a flip is runtime-mutable.
 * Default off ⇒ append_only passthrough, byte-identical. CONFLICT_
 * sits off the ENGINE flag budget by design (a resolver-policy knob
 * family — cfg weights/thresholds — not an engine fork).
 */
export function conflictDirectFactSlotEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_DIRECT_FACT_SLOT);
}

/**
 * Mention-path conflict semantics — CONFLICT_MENTION_FACT_SLOT.
 *
 * The mention/extraction path resolves a canonicalized predicate to its
 * registry policy; for a single-value slot that policy is
 * 'single_active', whose resolver branch supersedes UNCONDITIONALLY
 * (0085 `$supersede = $semantics = 'single_active' OR …`) and can never
 * surface a COMPETING pair. Two conversations asserting contradictory
 * values of one (userId, entity, predicate) slot therefore never form a
 * conflict — the second assertion silently replaces the first and
 * serving picks one side (state-transitions s07).
 *
 * When on, FactResolverService promotes JUST that combination — mention
 * path (no recordOutcomeMetric) AND registry semantics 'single_active'
 * — to 'bitemporal': the SAME conflict-slot doctrine the direct path
 * uses (close-scored contradictions become COMPETING, both linked; a
 * clear winner still SUPERSEDES; an equal value from a different origin
 * CORROBORATES — the fn's exact `object = $object` check, no fuzzier
 * matching). Candidates stay scope-local (0055: fn::resolve_fact
 * filters by $user_id), so different users never collide. The
 * append_only bulk and DEFAULT_FALLBACK are untouched (load-bearing for
 * open-vocabulary mention extraction), as is the direct typed path. The
 * env read lives here in the common layer (engine-gates S5.2), read at
 * call time so a flip is runtime-mutable. Default off ⇒ registry
 * passthrough, byte-identical. CONFLICT_ sits off the ENGINE flag
 * budget by design (a resolver-policy knob family — cfg
 * weights/thresholds — not an engine fork).
 */
export function conflictMentionFactSlotEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_MENTION_FACT_SLOT);
}

/**
 * Write-side slot canonicalization — CONFLICT_SLOT_CANONICALIZATION.
 *
 * The conflict machinery pairs only identical (userId, entity,
 * predicate) slots, but the extractor legitimately splits ONE
 * contradicted attribute across two predicates: "lease runs until
 * December 2026" is a duration phrase (duration_limit, append_only
 * harvest predicate) while "lease ends in September 2026" is a
 * lifecycle claim (status, single_active) — so no collision
 * structurally exists and CONFLICT_MENTION_FACT_SLOT is starved
 * (state-transitions s07, measured live).
 *
 * When on, FactResolverService routes a mention-path fact whose
 * predicate sits in a SMALL DECLARED alias table (duration_limit →
 * status) AND whose object carries an explicit calendar anchor (full
 * month name + 4-digit year, or an ISO date — a lease-end/deadline
 * claim, never a bare unit duration like "30 days") into the canonical
 * single-value slot, so both arms of the contradiction meet in one
 * (userId, entity, predicate) slot and the normal single_active /
 * bitemporal machinery sees the collision. Purely deterministic (static
 * table + regex — no DB read, no fuzzy matching, no LLM), order-free
 * and idempotent: both arms map to the same slot regardless of arrival
 * order. The direct typed path (caller states its slot), the harvest
 * bulk without calendar anchors, and every other predicate are
 * untouched. The env read lives here in the common layer (engine-gates
 * S5.2), read at call time so a flip is runtime-mutable. Default off ⇒
 * extracted-predicate passthrough, byte-identical. CONFLICT_ sits off
 * the ENGINE flag budget by design (a resolver-policy knob family, not
 * an engine fork).
 */
export function conflictSlotCanonicalizationEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_SLOT_CANONICALIZATION);
}

/**
 * Succession tiebreaker for the bitemporal close-margin doctrine —
 * CONFLICT_TEMPORAL_TIEBREAKER.
 *
 * The #444/#455 promotion (CONFLICT_MENTION_FACT_SLOT + slot-exact
 * cosine floor) routes mention-path single-value slots into
 * fn::resolve_fact's margin doctrine, where batch-shaped corpora score
 * every write identically (margin ~0) and EVERY same-slot pairing
 * lands COMPETING — genuine temporal updates included ("now NATS
 * JetStream" ended competing; honest serving then abstains on a
 * settled current value — memory-fitness run mfmtqn2jiq, 28/30 →
 * 23/30). Score margin alone cannot tell a temporal UPDATE from a
 * CONTRADICTION, and neither can validFrom separation (measured: the
 * s07 contradiction arms are 6 days apart, the launch update 16, the
 * payout-cutoff contradiction 15, the killing pairing 25 minutes) or
 * origin identity (one recorder per battery). What DOES distinguish
 * them in the data is the update-language cue: successions say so
 * ("is now X", "moves from A to B", "instead of", "no longer"),
 * contradictions assert states without succession markers.
 *
 * When on, the mention path computes a deterministic succession-cue
 * regex over the object (hasUpdateCue in fact-resolver.service.ts) and
 * binds it, with the ambiguity window
 * (CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS, default 0, clamped), into
 * fn::resolve_fact (migration 0129): a close-margin write whose object
 * carries the cue CLOSES pool members with a strictly-earlier-beyond-
 * window validFrom as superseded history instead of flipping them to
 * COMPETING; cue-less writes, same-stamp pairs and the direct typed
 * path (which never computes the cue) keep the existing doctrine.
 * The env read lives here in the common layer (engine-gates S5.2),
 * read at call time so a flip is runtime-mutable. Default off ⇒ the
 * new fn args are never bound, byte-identical. CONFLICT_ sits off the
 * ENGINE flag budget by design (a resolver-policy knob family — cfg
 * weights/thresholds — not an engine fork).
 */
export function conflictTemporalTiebreakerEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_TEMPORAL_TIEBREAKER);
}
