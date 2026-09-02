import type { DomainPackManifest } from '../../ai/domain-packs';
import { declaredModalitySection, modalitiesChecksum } from '../../ai/domain-packs';
import type { DerivedRepresentationKind, EvidenceModality } from '../../common/evidence-taxonomy';

/**
 * Pure per-dispatch gate of the trusted processor broker (0121) — the
 * gateRawEvidence mold (src/mcp/raw-evidence-gate.ts): deny-overrides,
 * ALL checks must hold, checked in order, first failure wins. The
 * EVIDENCE_PROCESSOR_BROKER flag itself is checked by the SERVICE (503),
 * not here — this function stays pure and unit-testable.
 *
 * Order of checks:
 *   (a) [service] processorBrokerEnabled() — 503, not a decision;
 *   (b) the pack manifest declares a `memoryModel.processors` entry whose
 *       `modality` matches the asset and whose `produces` includes the
 *       requested capability (declarative need only — anti-DSL doctrine:
 *       no pack-supplied endpoint/model/prompt is ever consulted);
 *   (c) consent is current: acceptedModalities === true AND the stored
 *       checksum equals the checksum of the CURRENT manifest's media
 *       section (every evidence_asset is non-text by construction —
 *       EVIDENCE_MODALITIES excludes text — so the consent gate ALWAYS
 *       applies to dispatch);
 *   (d) quarantine: 'quarantined' / 'scanning' / 'rejected' deny;
 *       NONE / 'clean' pass — absent = legacy internal row, safe
 *       unconditionally because nothing writes a non-clean status while
 *       EVIDENCE_QUARANTINE is off;
 *   (e) availability 'gone' denies (tombstone — bytes are unrecoverable).
 */
export type DispatchDecision = { allowed: true } | { allowed: false; reason: string };

export interface DispatchGateOpts {
  manifest: DomainPackManifest;
  /** Stored consent row state (domain_pack.acceptedModalities, 0112). */
  acceptedModalities: boolean;
  acceptedModalitiesChecksum: string | null;
  capability: DerivedRepresentationKind;
  asset: {
    modality: EvidenceModality;
    availability: string;
    /** The row's quarantineStatus column — pass exactly what it holds
     *  (undefined/null = legacy/off-era row, reads as clean). */
    quarantineStatus?: string | null | undefined;
  };
}

export function gateProcessorDispatch(opts: DispatchGateOpts): DispatchDecision {
  const processors = opts.manifest.memoryModel?.processors ?? [];
  const declared = processors.some(
    (processor) =>
      processor.modality === opts.asset.modality && processor.produces.includes(opts.capability),
  );
  if (!declared) {
    return {
      allowed: false,
      reason:
        `pack "${opts.manifest.id}" does not declare a ` +
        `${opts.asset.modality}→${opts.capability} processor need`,
    };
  }
  const currentChecksum = modalitiesChecksum(declaredModalitySection(opts.manifest));
  if (opts.acceptedModalities !== true || opts.acceptedModalitiesChecksum !== currentChecksum) {
    return {
      allowed: false,
      reason:
        `pack "${opts.manifest.id}" has no current modality consent ` +
        `(re-install with acceptModalities: true)`,
    };
  }
  const quarantine = opts.asset.quarantineStatus;
  if (quarantine === 'quarantined' || quarantine === 'scanning' || quarantine === 'rejected') {
    return { allowed: false, reason: `asset is ${quarantine} — quarantine blocks processing` };
  }
  if (opts.asset.availability === 'gone') {
    return { allowed: false, reason: 'asset bytes are gone (tombstone)' };
  }
  return { allowed: true };
}
