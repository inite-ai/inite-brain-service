import type { DomainPackManifest } from '../ai/domain-packs';
import { declaredModalitySection, modalitiesChecksum } from '../ai/domain-packs';
import { mediaPiiAllowed } from '../common/media-pii';

/**
 * Per-call gate for pack tools that would serve RAW media evidence
 * (media/biometric tier, Brain v2.1).
 *
 * NO tool currently serves raw evidence — this is the guard the future
 * surface MUST call, once per served fragment, before returning bytes or
 * a signed URL. The intended call site is the pack-tool handler layer in
 * mcp.service.ts, alongside the deny-overrides tool gates
 * (applyPolicyToolGate / applyGrantToolGate): those decide whether a tool
 * is REGISTERED; this decides whether one CALL may serve one fragment.
 * Kept in its own module so the pending tool-observation wrapper PR in
 * mcp.service.ts rebases cleanly around it.
 *
 * Deny-overrides — ALL of the following must hold, checked in order,
 * first failure wins:
 *   (a) the pack manifest declares the raw-evidence capability
 *       (declaredModalitySection().rawEvidence — see modality-consent.ts);
 *   (b) the tenant's stored consent is current: acceptedModalities === true
 *       AND the stored checksum equals the checksum of the CURRENT
 *       manifest's media section (a row edited out-of-band, or consent
 *       recorded for an older declaration, serves nothing);
 *   (c) the fragment passes the media PII gate (src/common/media-pii.ts):
 *       unclassified (NONE) blocked, non-empty blocked without
 *       brain:read_media, only `[]` (affirmatively clean) or the scope
 *       opens it.
 */
export type RawEvidenceDecision = { allowed: true } | { allowed: false; reason: string };

export function gateRawEvidence(opts: {
  manifest: DomainPackManifest;
  /** Stored consent row state (domain_pack.acceptedModalities, 0112). */
  acceptedModalities: boolean;
  acceptedModalitiesChecksum: string | null;
  callerScopes: readonly string[];
  /** The fragment's piiClasses column — pass exactly what the row holds
   *  (undefined/null = unclassified). */
  fragmentPiiClasses: readonly string[] | null | undefined;
}): RawEvidenceDecision {
  const section = declaredModalitySection(opts.manifest);
  if (!section || section.rawEvidence === undefined) {
    return {
      allowed: false,
      reason: `pack "${opts.manifest.id}" does not declare the raw-evidence capability`,
    };
  }
  const currentChecksum = modalitiesChecksum(section);
  if (opts.acceptedModalities !== true || opts.acceptedModalitiesChecksum !== currentChecksum) {
    return {
      allowed: false,
      reason:
        `pack "${opts.manifest.id}" has no current modality consent ` +
        `(re-install with acceptModalities: true)`,
    };
  }
  if (!mediaPiiAllowed(opts.fragmentPiiClasses, opts.callerScopes)) {
    return {
      allowed: false,
      reason:
        opts.fragmentPiiClasses == null
          ? 'fragment is unclassified for media PII (fail closed)'
          : 'fragment carries media PII classes and the caller lacks brain:read_media',
    };
  }
  return { allowed: true };
}
