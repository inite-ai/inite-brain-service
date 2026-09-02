/**
 * Processing lifecycle (0121) — pure dispatch-gate ladder (the
 * gateRawEvidence mold): deny-overrides, checked in order, first failure
 * wins. Declaration → consent (current checksum) → quarantine →
 * availability.
 */
import {
  declaredModalitySection,
  modalitiesChecksum,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import { gateProcessorDispatch } from '../src/evidence/processing/dispatch-gate';

const manifest = (memoryModel?: Record<string, unknown>): DomainPackManifest =>
  ({
    id: 'proc_pack',
    version: '1.0.0',
    description: 'Synthetic processor pack (unit).',
    predicates: [],
    ...(memoryModel ? { memoryModel } : {}),
  }) as unknown as DomainPackManifest;

const DECLARING = manifest({
  modalities: ['image'],
  processors: [{ id: 'img_cap', modality: 'image', produces: ['caption'] }],
});
const CURRENT = modalitiesChecksum(declaredModalitySection(DECLARING));

const gate = (over: Partial<Parameters<typeof gateProcessorDispatch>[0]> = {}) =>
  gateProcessorDispatch({
    manifest: DECLARING,
    acceptedModalities: true,
    acceptedModalitiesChecksum: CURRENT,
    capability: 'caption',
    asset: { modality: 'image', availability: 'hot' },
    ...over,
  });

describe('gateProcessorDispatch — deny-overrides ladder', () => {
  it('allows the declared, consented, clean-or-legacy, non-gone case', () => {
    expect(gate()).toEqual({ allowed: true });
  });

  it('denies an undeclared capability', () => {
    const d = gate({ capability: 'ocr' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('does not declare');
  });

  it('denies a modality mismatch (declared need is per-modality)', () => {
    const d = gate({ asset: { modality: 'audio', availability: 'hot' } });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('does not declare');
  });

  it('denies when consent was never accepted', () => {
    const d = gate({ acceptedModalities: false });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('no current modality consent');
  });

  it('denies a STALE checksum — the media section changed after consent', () => {
    // Consent was recorded for the ORIGINAL declaration; the manifest's
    // media section then grew — the stored checksum no longer matches,
    // which is exactly the re-consent trigger.
    const edited = manifest({
      modalities: ['image', 'audio'],
      processors: [{ id: 'img_cap', modality: 'image', produces: ['caption'] }],
    });
    const d = gate({ manifest: edited });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('no current modality consent');
  });

  it.each(['quarantined', 'scanning', 'rejected'] as const)('denies quarantineStatus=%s', (qs) => {
    const d = gate({ asset: { modality: 'image', availability: 'hot', quarantineStatus: qs } });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('quarantine');
  });

  it.each([undefined, null, 'clean'] as const)('passes quarantineStatus=%s', (qs) => {
    expect(
      gate({ asset: { modality: 'image', availability: 'hot', quarantineStatus: qs } }).allowed,
    ).toBe(true);
  });

  it("denies availability 'gone' (tombstone)", () => {
    const d = gate({ asset: { modality: 'image', availability: 'gone' } });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('gone');
  });

  it('first failure wins: declaration outranks quarantine outranks gone', () => {
    const worst = gate({
      capability: 'ocr',
      asset: { modality: 'image', availability: 'gone', quarantineStatus: 'rejected' },
    });
    if (!worst.allowed) expect(worst.reason).toContain('does not declare');
    const quarantinedGone = gate({
      asset: { modality: 'image', availability: 'gone', quarantineStatus: 'rejected' },
    });
    if (!quarantinedGone.allowed) expect(quarantinedGone.reason).toContain('quarantine');
  });
});
