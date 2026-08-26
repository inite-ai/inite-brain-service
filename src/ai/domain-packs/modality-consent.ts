import { createHash } from 'node:crypto';
import { canonicalJson } from './checksum';
import type { DomainPackManifest } from './manifest';

/**
 * Install-time consent for pack-declared NON-TEXT modality processing
 * (media/biometric tier, migration 0112 — the modality sibling of the
 * 0068 mcpTools consent in ./mcp-consent.ts).
 *
 * A pack that declares image/audio/video processing changes what the
 * tenant's memory substrate DOES with raw media (classification, storage,
 * possibly serving raw evidence back out) — that must be an explicit
 * operator decision, not a side effect of installing an ontology. ONE
 * checksum covers the whole media section (declared non-text modalities +
 * any raw-evidence capability declaration): any change to either is a
 * single re-consent trigger; a byte-identical section carries prior
 * consent over.
 *
 * Pure helpers — DomainPackInstallService owns the DB row and maps the
 * returned message to a 400.
 */

/** The manifest's media section, as consented to (checksum input). */
export interface ModalityConsentSection {
  /** Declared non-text modality entries, verbatim from the manifest. */
  modalities: unknown[];
  /** Raw-evidence capability declaration, verbatim; absent when none. */
  rawEvidence?: unknown;
}

/** Modality entry shapes the defensive probe understands. */
type ModalityEntry = string | { kind?: unknown; type?: unknown; modality?: unknown };

function modalityName(entry: ModalityEntry): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const name = entry.kind ?? entry.type ?? entry.modality;
    if (typeof name === 'string') return name;
  }
  return null;
}

/**
 * THE documented accessor for the manifest's modality declaration —
 * bind-point for the P-track manifest field.
 *
 * The typed manifest does not carry the field yet (it arrives with a
 * sibling P-track PR), so this probes defensively:
 * `manifest.memoryModel.modalities` first, `manifest.memoryModel
 * .processors` as the fallback spelling, and `manifest.memoryModel
 * .rawEvidence` for the raw-evidence capability. When the typed field
 * lands, ONLY this function changes (one line per probe) — every
 * consumer (install enforcement, raw-evidence gate, tests) reads the
 * declaration through here.
 *
 * Returns null when the pack declares nothing beyond text (the inert
 * case — every existing pack), else the section that gets checksummed:
 * declared NON-TEXT modality entries verbatim plus the raw-evidence
 * declaration, so a change to either re-triggers consent.
 */
export function declaredModalitySection(
  manifest: DomainPackManifest,
): ModalityConsentSection | null {
  const memoryModel = (
    manifest as {
      memoryModel?: { modalities?: unknown; processors?: unknown; rawEvidence?: unknown };
    }
  ).memoryModel;
  if (!memoryModel || typeof memoryModel !== 'object') return null;
  const declared = memoryModel.modalities ?? memoryModel.processors;
  const nonText = Array.isArray(declared)
    ? (declared as ModalityEntry[]).filter((m) => modalityName(m) !== 'text')
    : [];
  const rawEvidence = memoryModel.rawEvidence;
  if (nonText.length === 0 && rawEvidence === undefined) return null;
  return { modalities: nonText, ...(rawEvidence !== undefined ? { rawEvidence } : {}) };
}

/** The manifest's raw-evidence capability declaration, or null when the
 *  pack does not declare it (raw serving denied — see
 *  src/mcp/raw-evidence-gate.ts). Same bind-point discipline as
 *  {@link declaredModalitySection}. */
export function rawEvidenceCapability(manifest: DomainPackManifest): unknown {
  return declaredModalitySection(manifest)?.rawEvidence ?? null;
}

/** sha256 hex of the canonical media section; null when absent. Takes the
 *  section as an ARGUMENT (not the manifest) so the exact manifest field
 *  name can land later without touching the checksum. */
export function modalitiesChecksum(section: ModalityConsentSection | null): string | null {
  if (!section) return null;
  return createHash('sha256').update(canonicalJson(section)).digest('hex');
}

/**
 * Decide whether this install/upgrade needs the `acceptModalities` flag —
 * mirrors mcpConsentRequired: re-consent on checksum change, carry-over
 * when the stored checksum matches. Returns the client-facing refusal
 * message (listing what the operator would accept), or null when consent
 * is granted or not required.
 */
export function modalityConsentRequired(opts: {
  packId: string;
  version: string;
  /** From {@link declaredModalitySection} — null = nothing declared. */
  declared: ModalityConsentSection | null;
  accepted: boolean | undefined;
  /** Prior row state — pass false/null on a fresh install. */
  priorAccepted: boolean;
  priorChecksum: string | null;
}): string | null {
  const checksum = modalitiesChecksum(opts.declared);
  if (!checksum || !opts.declared) return null; // nothing declared — inert
  if (opts.accepted === true) return null;
  if (opts.priorAccepted && opts.priorChecksum === checksum) return null;
  const names = opts.declared.modalities
    .map((m) => modalityName(m as ModalityEntry) ?? JSON.stringify(m))
    .join(', ');
  const rawNote =
    opts.declared.rawEvidence !== undefined ? '; declares the raw-evidence capability' : '';
  return (
    `pack "${opts.packId}" v${opts.version} declares non-text modality ` +
    `processing (${names || 'none'})${rawNote}. ` +
    `Review the declaration and repeat the install with acceptModalities: true.`
  );
}
