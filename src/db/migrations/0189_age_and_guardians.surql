-- 0189_age_and_guardians — what the memory knows about a person's age, who
-- their guardian is, and whose consent a grant is (#916 step 1).
--
-- WHY. Children are protected everywhere an emotional companion is
-- regulated: GDPR art. 8 (parental consent under 13–16, by member state),
-- China's anthropomorphic-AI measures (guardian consent under 14, minor
-- mode), California SB 243 (known minors) and its 2026 successors. The
-- Replika fine (Garante 2025) was for having no age assurance at all. A
-- consent a child gives to inference about how they feel is not one the
-- memory may act on.
--
-- user_age: one row per person — how sure the operator is (declared by
-- the person, estimated by a model or signal, verified by a check), and
-- whether they are a minor where they live (the operator decides; the
-- threshold differs by jurisdiction, so brain records the outcome, not a
-- birth date). Optional coarse band, never a date of birth.
--
-- guardian_link: the person's guardian, as the operator knows them (an
-- opaque reference — brain holds no guardian identity data).
--
-- consent_record.grantedBy: 'person' (default, every 0187 row) or
-- 'guardian'. For a minor, only a guardian's grant counts.
--
-- All carry userId and go with user forget. Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS user_age SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON user_age TYPE string;
DEFINE FIELD IF NOT EXISTS status ON user_age TYPE string
  ASSERT $value IN ['declared', 'estimated', 'verified'];
DEFINE FIELD IF NOT EXISTS minor ON user_age TYPE bool;
DEFINE FIELD IF NOT EXISTS ageBand ON user_age TYPE option<string>
  ASSERT $value = NONE OR $value IN ['under_13', '13_15', '16_17', 'adult'];
DEFINE FIELD IF NOT EXISTS method ON user_age TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS assuredAt ON user_age TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS recordedBy ON user_age TYPE option<string>;
DEFINE INDEX IF NOT EXISTS user_age_user_uq ON user_age FIELDS userId UNIQUE;

DEFINE TABLE IF NOT EXISTS guardian_link SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON guardian_link TYPE string;
DEFINE FIELD IF NOT EXISTS guardianRef ON guardian_link TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS verifiedAt ON guardian_link TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS recordedBy ON guardian_link TYPE option<string>;
DEFINE INDEX IF NOT EXISTS guardian_link_user_uq ON guardian_link FIELDS userId UNIQUE;

DEFINE FIELD IF NOT EXISTS grantedBy ON consent_record TYPE string DEFAULT 'person'
  ASSERT $value IN ['person', 'guardian'];
