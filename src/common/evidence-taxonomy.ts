/**
 * Canonical multimodal Evidence Plane vocabulary.
 *
 * Storage, pack perception contracts, migrations, and future capability
 * brokers must use these values verbatim. Text is intentionally not an asset
 * modality; PackMemoryModel adds it as the zero-consent baseline.
 */
export const EVIDENCE_MODALITIES = ['image', 'audio', 'video', 'document', 'sensor'] as const;
export type EvidenceModality = (typeof EVIDENCE_MODALITIES)[number];

/** Recomputable interpretations stored in derived_representation.kind. */
export const DERIVED_REPRESENTATION_KINDS = [
  'caption',
  'ocr',
  'asr',
  'object_track',
  'scene_graph',
  'embedding',
  'text',
] as const;
export type DerivedRepresentationKind = (typeof DERIVED_REPRESENTATION_KINDS)[number];
