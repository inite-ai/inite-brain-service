-- 0173: dream_pair_checked — the nightly judges remember what they already judged.
--
-- LLM spend audit, 2026-10-28. Dreams dedup left a trace only for a
-- `same` verdict (the identity_of edge): every `different` and `unsure`
-- pair was rebuilt and judged again every night, forever, and with seeds
-- ordered newest-first under a 50-pair cap the same top pairs came back
-- each night while older candidates never got a turn. Dreams resolve kept
-- nothing for an `unsure` pair either: the same 20 pairs were re-asked
-- nightly. corroborate_checked (0060) already does this for corroboration.
--
-- One row per (kind, pairKey). `signature` is what the judge saw (a hash
-- of its input): a different signature means new evidence and the pair is
-- judged again; so does a row older than the recheck window
-- (src/dreams/pair-memo.ts). Ids and hashes only — no memory content —
-- so a forgotten entity leaves nothing readable here, as with
-- corroborate_checked.
--
-- Idempotent: IF NOT EXISTS throughout; no backfill (an empty memo means
-- every pair is judged once more, which is what happened every night).

DEFINE TABLE IF NOT EXISTS dream_pair_checked SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS kind      ON dream_pair_checked TYPE string;
DEFINE FIELD IF NOT EXISTS pairKey   ON dream_pair_checked TYPE string;
DEFINE FIELD IF NOT EXISTS signature ON dream_pair_checked TYPE string;
DEFINE FIELD IF NOT EXISTS verdict   ON dream_pair_checked TYPE string;
DEFINE FIELD IF NOT EXISTS checkedAt ON dream_pair_checked TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS dream_pair_checked_key_idx
  ON dream_pair_checked FIELDS kind, pairKey UNIQUE;
