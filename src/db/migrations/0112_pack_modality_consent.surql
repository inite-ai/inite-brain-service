-- 0112_pack_modality_consent — install-time consent for pack-declared
-- non-text modality processing (media/biometric tier, Brain v2.1). Mirrors
-- the 0068 mcpTools consent fields: ONE checksum covers the whole media
-- section of the manifest (declared non-text modalities + any raw-evidence
-- capability declaration), so ANY change to that section is a single
-- re-consent trigger; an upgrade that leaves it byte-identical carries the
-- stored consent over. See src/ai/domain-packs/modality-consent.ts.
-- (0108-0111 are claimed by in-flight sibling PRs; this file deliberately
-- takes 0112 — the gap closes as those PRs merge.)
DEFINE FIELD IF NOT EXISTS acceptedModalities ON domain_pack TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS acceptedModalitiesChecksum ON domain_pack TYPE option<string>;
