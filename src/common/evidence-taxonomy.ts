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

/** Lifecycle states of a platform-executed processing run (0121). */
export const PROCESSING_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'superseded',
] as const;
export type ProcessingRunStatus = (typeof PROCESSING_RUN_STATUSES)[number];

/** External-ingest quarantine states on evidence_asset (0121). Absent =
 *  legacy/off-era row, read as clean (all pre-seam writes were internal). */
export const QUARANTINE_STATUSES = ['quarantined', 'scanning', 'clean', 'rejected'] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];
