import { EVIDENCE_MODALITIES, type EvidenceModality } from '../common/evidence-taxonomy';

/**
 * Upload media-type allowlist (Brain v2.1 MM-7) — the ONE place that says
 * which bytes the blob upload surface will take into custody, and under
 * which modality.
 *
 * ALLOWLIST, not a denylist, and deliberately narrow: the metadata-only
 * sibling route accepts any IANA-shaped `mediaType` because it never
 * holds the bytes, but this surface stores them and later hands them to
 * processor adapters and the raw-read gateway. Everything not named here
 * is refused, including — on purpose:
 *
 *   - `image/svg+xml`: an SVG is an active document (script, external
 *     refs); serving one back from the raw gateway would be stored XSS;
 *   - `application/octet-stream` and other opaque types: an unclassified
 *     blob cannot be modality-checked, so it can never be honestly
 *     described to a pack's perception contract;
 *   - archives (zip/tar/gz) and macro-capable office formats: a container
 *     is a delivery vehicle, and nothing in v1 unpacks or scans inside
 *     one (the scan hook is a metadata-only stub);
 *   - `text/html`: same active-content reasoning as SVG.
 *
 * The pairing matters as much as the membership: a `image/png` part may
 * not be registered as modality `document`, because modality drives pack
 * consent (0112), the dispatch gate, and the fragment-locator matrix. A
 * mismatched pair is a 400, never a silent re-classification.
 *
 * Extending this list is a deliberate decision — a new entry means the
 * raw-read gateway may hand those bytes back to a browser.
 */
export const EVIDENCE_UPLOAD_MEDIA_TYPES: Readonly<Record<EvidenceModality, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/flac'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  document: ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'],
  sensor: ['application/json', 'text/csv'],
};

/** Flat union of every accepted type — for docs and error messages. */
export const EVIDENCE_UPLOAD_MEDIA_TYPES_FLAT: readonly string[] = [
  ...new Set(EVIDENCE_MODALITIES.flatMap((m) => EVIDENCE_UPLOAD_MEDIA_TYPES[m])),
].sort();

/**
 * Canonical form of a wire media type: lowercased, parameters dropped
 * (`text/plain; charset=utf-8` → `text/plain`), surrounding space
 * trimmed. Parameters are dropped rather than rejected — a charset says
 * nothing about what the bytes ARE, and the allowlist keys on the
 * type/subtype only.
 */
export function normalizeUploadMediaType(raw: string): string {
  const semi = raw.indexOf(';');
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

/**
 * Pure allowlist check. Returns null when the (modality, mediaType) pair
 * is accepted, else a caller-safe reason string. Kept pure so the unit
 * suite can pin every pair without booting a Nest app.
 */
export function uploadMediaTypeError(modality: EvidenceModality, mediaType: string): string | null {
  const normalized = normalizeUploadMediaType(mediaType);
  if (normalized === '') return 'a media type is required for an uploaded blob';
  const allowed = EVIDENCE_UPLOAD_MEDIA_TYPES[modality];
  if (allowed.includes(normalized)) return null;
  if (EVIDENCE_UPLOAD_MEDIA_TYPES_FLAT.includes(normalized)) {
    return (
      `mediaType '${normalized}' is not accepted for modality '${modality}' ` +
      `(accepted: ${allowed.join(', ')})`
    );
  }
  return `mediaType '${normalized}' is not accepted by the evidence blob upload surface`;
}
