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

/**
 * Evidence-capability axis (0113): what KIND of evidence a claim can be
 * verified against. Canonical home of the union (synthesize.types.ts
 * re-exports it for the verdict-gate consumers); the runtime list backs
 * ASSERT-vocabulary pins and defensive parses.
 */
export const EVIDENCE_CAPABILITIES = ['text', 'visual', 'audio', 'document_region'] as const;
export type EvidenceCapability = (typeof EVIDENCE_CAPABILITIES)[number];

/**
 * The capability a cited fragment of a given asset modality actually
 * carries (MM-zoom PR2) — the bridge the evidence-capability verdict
 * gate (FOVEA_EVIDENCE_CAPABILITY) uses to let a non-text requirement
 * be SATISFIED by a matching-modality fragment citation instead of
 * always abstaining. Conservative by design: 'sensor' (and any unknown
 * value — modality is read from FLEXIBLE-adjacent rows) maps to 'text',
 * which adds nothing beyond the constant text baseline, so an
 * unclassifiable citation can never satisfy a non-text requirement.
 */
export function capabilityForModality(modality: string): EvidenceCapability {
  switch (modality) {
    case 'image':
    case 'video':
      return 'visual';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document_region';
    default:
      return 'text';
  }
}
