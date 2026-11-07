-- 0190_safety_layer — risk signals read from a person's words, and the log
-- of what the operator's protocol did (#916 step 2).
--
-- WHY. CA SB 243 (from 2026-01-01) and NY GBL art. 47 require an operator
-- of a companion to detect expressions of suicidal ideation or self-harm,
-- refer the person to a crisis service, disclose that the companion is AI
-- (and, for a known minor, remind them to take a break every three hours),
-- and — SB 243, from 2027-07-01 — report counts of crisis referrals to the
-- Office of Suicide Prevention with NO personal identifiers. The memory
-- holds the history the detection needs and is the natural place for the
-- record; brain reads and records, the operator's protocol acts.
--
-- risk_signal: one span of a person's own turn read as a risk (C-SSRS
-- ideation ladder folded to concern / urgent), with the exact words, the
-- turn's scope tags (circle fence, as affect_observation) and the reader.
-- Class `health` (GDPR art. 9): every read needs brain:read_pii. Deleted
-- after the declaring pack's safetyMonitoring.retentionDays and by user
-- forget; exported and erased with the person's emotional data.
--
-- safety_event: what the operator's protocol did — AI disclosure shown,
-- break reminder shown, crisis referral shown (with the resource), a
-- minor's safety setting changed, an emotion-recognition notice shown
-- (AI Act art. 50(3)). User forget does NOT delete these rows: it removes
-- the userId, so the identifier-free counts the law asks for survive the
-- person's erasure and nothing identifies them.
--
-- Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS risk_signal SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON risk_signal TYPE string;
DEFINE FIELD IF NOT EXISTS episodeId ON risk_signal TYPE record<episode>;
DEFINE FIELD IF NOT EXISTS conversationId ON risk_signal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON risk_signal TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS observedAt ON risk_signal TYPE datetime;
DEFINE FIELD IF NOT EXISTS level ON risk_signal TYPE string
  ASSERT $value IN ['concern', 'urgent'];
DEFINE FIELD IF NOT EXISTS quote ON risk_signal TYPE string;
DEFINE FIELD IF NOT EXISTS spanStart ON risk_signal TYPE int;
DEFINE FIELD IF NOT EXISTS spanEnd ON risk_signal TYPE int;
DEFINE FIELD IF NOT EXISTS confidence ON risk_signal TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS readerVersion ON risk_signal TYPE string;
DEFINE FIELD IF NOT EXISTS model ON risk_signal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS piiClass ON risk_signal TYPE string DEFAULT 'health'
  ASSERT $value = 'health';
DEFINE FIELD IF NOT EXISTS createdAt ON risk_signal TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS risk_signal_user_idx ON risk_signal FIELDS userId;
DEFINE INDEX IF NOT EXISTS risk_signal_observed_idx ON risk_signal FIELDS observedAt;

DEFINE TABLE IF NOT EXISTS safety_event SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON safety_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS type ON safety_event TYPE string
  ASSERT $value IN ['ai_disclosure_shown', 'break_reminder_shown', 'crisis_referral_shown',
                    'minor_safety_setting_changed', 'emotion_recognition_notice_shown'];
DEFINE FIELD IF NOT EXISTS protocolVersion ON safety_event TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
-- The crisis resource referred to (e.g. "988"), for crisis_referral_shown.
DEFINE FIELD IF NOT EXISTS resource ON safety_event TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS at ON safety_event TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS recordedBy ON safety_event TYPE option<string>;
DEFINE INDEX IF NOT EXISTS safety_event_user_idx ON safety_event FIELDS userId;
DEFINE INDEX IF NOT EXISTS safety_event_at_idx ON safety_event FIELDS at;
