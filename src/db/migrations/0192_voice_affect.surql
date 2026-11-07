-- 0192_voice_affect — arousal read from a person's voice, the deployment
-- context it is allowed in, and the cursor over recordings (#916 step 4).
--
-- WHY HIGH-RISK. Inferring emotion from voice is biometric emotion
-- recognition under the EU AI Act: prohibited at work and in education
-- (art. 5(1)(f), from 2025-02-02), high-risk elsewhere (Annex III, from
-- 2027-12-02), and the people exposed must be told (art. 50(3)). So:
--  - domain_pack.deploymentContext records where the operator deploys the
--    tenant (consumer / workplace / education / other); a pack declaring
--    voiceAffectInference is refused at install without one, and for
--    workplace / education, and the reader re-checks it at run time;
--  - a voice observation is an affect_observation with modality 'voice':
--    arousal / energy only (natural speech carries arousal far better than
--    valence or discrete emotions), a time range of the recording, no
--    words — so valence, label and quote become optional for it;
--  - voice_affect_reading marks a recording read by a reader version.
--
-- Read only for recordings the operator marked as the person's own voice
-- (evidence_asset.meta.speaker = 'self'), with the person's consent
-- (purpose voice_affect_inference) and after their notice was recorded
-- (safety_event emotion_recognition_notice_shown). Idempotent.

DEFINE FIELD IF NOT EXISTS deploymentContext ON domain_pack TYPE option<string>
  ASSERT $value = NONE OR $value IN ['consumer', 'workplace', 'education', 'other'];

DEFINE FIELD OVERWRITE modality ON affect_observation TYPE string DEFAULT 'text'
  ASSERT $value IN ['text', 'voice'];
DEFINE FIELD OVERWRITE valence ON affect_observation TYPE option<float>
  ASSERT $value = NONE OR ($value >= -1 AND $value <= 1);
DEFINE FIELD OVERWRITE label ON affect_observation TYPE option<string>
  ASSERT $value = NONE OR $value IN ['anger', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'neutral'];
DEFINE FIELD OVERWRITE quote ON affect_observation TYPE option<string>;
DEFINE FIELD OVERWRITE spanStart ON affect_observation TYPE option<int>;
DEFINE FIELD OVERWRITE spanEnd ON affect_observation TYPE option<int>;
DEFINE FIELD OVERWRITE episodeId ON affect_observation TYPE option<record<episode>>;
DEFINE FIELD IF NOT EXISTS arousal ON affect_observation TYPE option<float>
  ASSERT $value = NONE OR ($value >= 0 AND $value <= 1);
DEFINE FIELD IF NOT EXISTS assetId ON affect_observation TYPE option<record<evidence_asset>>;
DEFINE FIELD IF NOT EXISTS startMs ON affect_observation TYPE option<int>;
DEFINE FIELD IF NOT EXISTS endMs ON affect_observation TYPE option<int>;

DEFINE TABLE IF NOT EXISTS voice_affect_reading SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON voice_affect_reading TYPE string;
DEFINE FIELD IF NOT EXISTS assetId ON voice_affect_reading TYPE record<evidence_asset>;
DEFINE FIELD IF NOT EXISTS readerVersion ON voice_affect_reading TYPE string;
DEFINE FIELD IF NOT EXISTS observations ON voice_affect_reading TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS readAt ON voice_affect_reading TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS voice_affect_reading_user_idx ON voice_affect_reading FIELDS userId;
DEFINE INDEX IF NOT EXISTS voice_affect_reading_uq ON voice_affect_reading FIELDS assetId, readerVersion UNIQUE;
