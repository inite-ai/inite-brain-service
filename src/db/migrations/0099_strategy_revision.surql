-- 0099: strategy_memory candidate-revision pointer + caller-asserted
-- evidence label — the R3 P1 hardening of G4's capture path (bet #3).
--
-- WHY. A distill/trajectory-capture merge (strategy-distill.service.ts
-- dedupMerge) that targeted an already-serving `active` row used to mutate
-- it IN PLACE (mergeUpdate never sets `status`), silently changing what
-- retrieve() serves and bypassing candidate→active review. The fix makes
-- active rows IMMUTABLE to capture: a merge onto an active row instead
-- proposes a NEW `candidate` revision that carries the merged content +
-- experience and points at the active row it supersedes. The active row
-- stays byte-identical until a human promotes the revision (updateStatus).
--
-- ADDITIVE + OPTIONAL by construction (the 0098 posture): every column is
-- option<...>, so existing rows are unaffected and NO backfill is needed.
-- A write that omits these fields stores nothing for them. The whole
-- capture path is gated OFF by STRATEGY_MEMORY_ENABLED at the service
-- layer — master off ⇒ these columns are never written and never selected,
-- so serving is byte-identical to pre-0099.

-- The active strategy_memory row this candidate revision proposes to
-- replace. Stored as the opaque `strategy_memory:<id>` string (the same
-- shape strategyId already carries end to end — mapStrategyRow does
-- String(id), idTail parses the string), mirroring 0098's outcomeEvidenceRef
-- opaque-pointer idiom. Present only on revision candidates; NONE otherwise.
DEFINE FIELD IF NOT EXISTS supersedesId ON strategy_memory TYPE option<string>;

-- Explicit label that a stored outcomeEvidenceRef (0098) is CALLER-ASSERTED
-- and UNVERIFIED: there is no tenant evidence table to resolve the opaque
-- ref against, so it is persisted stamped `false`. The trajectory (and its
-- ref) is ADVICE, never evidence — it reaches the generator advisory only,
-- never the verifier bundle or citations (the G4 verifier-parity exception).
-- This flag makes the "not proof" posture explicit at the row level.
DEFINE FIELD IF NOT EXISTS outcomeEvidenceVerified ON strategy_memory TYPE option<bool>;
