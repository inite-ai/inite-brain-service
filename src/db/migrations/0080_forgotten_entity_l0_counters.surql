-- 0080_forgotten_entity_l0_counters — the GDPR cascade reaches L0
-- (episodes + segments; engine-audit W-item "GDPR не до L0"), and the
-- tombstone records those counters. entity-forget.service.ts has been
-- writing episodesDeleted/segmentsDeleted since the L0 cascade landed,
-- but the SCHEMAFULL table never learned the fields — every forget on
-- a migrated tenant 500s ("no such field exists for table
-- 'forgotten_entity'"). Caught by the e2e suite when CI unwedged.

DEFINE FIELD IF NOT EXISTS episodesDeleted ON forgotten_entity TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS segmentsDeleted ON forgotten_entity TYPE int DEFAULT 0;
