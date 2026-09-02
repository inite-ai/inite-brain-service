/**
 * Fragment citations (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2) — the
 * pure seams:
 *
 *  - resolveFragmentCitations: the rendered-set fence (unknown ids
 *    dropped + counted, never surfaced), rendered-excerpt-only,
 *    the one-of invariant (fragment arm only, no episodeId), dedupe,
 *    the cap, and the defensive parse of malformed generator entries;
 *  - capabilityForModality: the modality→capability bridge, including
 *    the conservative default ('sensor'/unknown → 'text' — can never
 *    satisfy a non-text requirement);
 *  - hasCurrentModalityConsent: the tenant-level 0112 serving gate —
 *    absent, unaccepted, and STALE-checksum rows all read as no
 *    consent; a current row opens it; malformed manifests never throw.
 */
import {
  resolveFragmentCitations,
  type CitableFragment,
} from '../src/synthesize/fragment-citations';
import { capabilityForModality, EVIDENCE_CAPABILITIES } from '../src/common/evidence-taxonomy';
import {
  declaredModalitySection,
  hasCurrentModalityConsent,
  modalitiesChecksum,
} from '../src/ai/domain-packs';
import type { DomainPackManifest } from '../src/ai/domain-packs';

const frag = (id: string, over: Partial<CitableFragment> = {}): CitableFragment => ({
  fragmentId: id,
  assetId: 'evidence_asset:a1',
  capability: 'visual',
  excerpt: 'a whiteboard with the evacuation plan',
  occurredAt: '2026-05-01T00:00:00.000Z',
  ...over,
});

const renderedSet = (...fragments: CitableFragment[]): Map<string, CitableFragment> =>
  new Map(fragments.map((f) => [f.fragmentId, f]));

describe('resolveFragmentCitations — the rendered-set fence', () => {
  it('a rendered id resolves to a fragment-arm citation carrying the RENDERED excerpt', () => {
    const { citations, counts } = resolveFragmentCitations(
      ['evidence_fragment:f1'],
      renderedSet(frag('evidence_fragment:f1')),
    );
    expect(citations).toEqual([
      {
        fragmentId: 'evidence_fragment:f1',
        assetId: 'evidence_asset:a1',
        capability: 'visual',
        excerpt: 'a whiteboard with the evacuation plan',
        occurredAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 0 });
    // ONE-OF invariant: the fragment arm never carries an episodeId.
    expect(citations[0]!.episodeId).toBeUndefined();
  });

  it('an id NOT in the rendered set is dropped and counted — never surfaced', () => {
    const { citations, counts } = resolveFragmentCitations(
      ['evidence_fragment:hallucinated', 'evidence_fragment:f1'],
      renderedSet(frag('evidence_fragment:f1')),
    );
    expect(citations.map((c) => c.fragmentId)).toEqual(['evidence_fragment:f1']);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 1 });
  });

  it('malformed entries (non-string, empty, wrong object) count as dropped; {fragmentId} objects are tolerated', () => {
    const { citations, counts } = resolveFragmentCitations(
      [42, '', null, { episodeId: 'episode:x' }, { fragmentId: 'evidence_fragment:f1' }],
      renderedSet(frag('evidence_fragment:f1')),
    );
    expect(citations.map((c) => c.fragmentId)).toEqual(['evidence_fragment:f1']);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 4 });
  });

  it('dedupes repeated ids (one citation, counted once)', () => {
    const { citations, counts } = resolveFragmentCitations(
      ['evidence_fragment:f1', 'evidence_fragment:f1'],
      renderedSet(frag('evidence_fragment:f1')),
    );
    expect(citations).toHaveLength(1);
    expect(counts.cited).toBe(1);
  });

  it('caps resolved citations at 16 (bounded output)', () => {
    const fragments = Array.from({ length: 20 }, (_, i) => frag(`evidence_fragment:f${i}`));
    const { citations } = resolveFragmentCitations(
      fragments.map((f) => f.fragmentId),
      renderedSet(...fragments),
    );
    expect(citations).toHaveLength(16);
  });

  it('an absent occurredAt is omitted, not emitted as undefined', () => {
    const noDate = frag('evidence_fragment:f2');
    delete (noDate as { occurredAt?: string }).occurredAt;
    const { citations } = resolveFragmentCitations(['evidence_fragment:f2'], renderedSet(noDate));
    expect('occurredAt' in citations[0]!).toBe(false);
  });
});

describe('capabilityForModality — the modality→capability bridge', () => {
  it.each([
    ['image', 'visual'],
    ['video', 'visual'],
    ['audio', 'audio'],
    ['document', 'document_region'],
    ['sensor', 'text'],
    ['something_else', 'text'],
  ] as const)('%s → %s', (modality, capability) => {
    expect(capabilityForModality(modality)).toBe(capability);
  });

  it('always lands inside the canonical capability union', () => {
    for (const m of ['image', 'audio', 'video', 'document', 'sensor', '???']) {
      expect(EVIDENCE_CAPABILITIES).toContain(capabilityForModality(m));
    }
  });
});

describe('hasCurrentModalityConsent — the tenant-level 0112 serving gate', () => {
  const manifest = {
    memoryModel: { modalities: ['text', 'image'] },
  } as unknown as DomainPackManifest;
  const currentChecksum = modalitiesChecksum(declaredModalitySection(manifest));

  it('a current consented declaring pack opens the gate', () => {
    expect(
      hasCurrentModalityConsent([
        { manifest, acceptedModalities: true, acceptedModalitiesChecksum: currentChecksum },
      ]),
    ).toBe(true);
  });

  it('absent consent (no declaring pack, or never accepted) reads closed', () => {
    expect(hasCurrentModalityConsent([])).toBe(false);
    // Text-only pack declares nothing — inert, not consent.
    expect(
      hasCurrentModalityConsent([
        {
          manifest: { memoryModel: { modalities: ['text'] } },
          acceptedModalities: true,
          acceptedModalitiesChecksum: 'anything',
        },
      ]),
    ).toBe(false);
    expect(
      hasCurrentModalityConsent([
        { manifest, acceptedModalities: undefined, acceptedModalitiesChecksum: currentChecksum },
      ]),
    ).toBe(false);
  });

  it('a STALE checksum (declaration changed since consent) reads closed', () => {
    expect(
      hasCurrentModalityConsent([
        { manifest, acceptedModalities: true, acceptedModalitiesChecksum: 'stale-checksum' },
      ]),
    ).toBe(false);
  });

  it('malformed manifest rows never throw and never grant', () => {
    expect(
      hasCurrentModalityConsent([
        { manifest: 'not-an-object', acceptedModalities: true },
        { manifest: null, acceptedModalities: true },
        { manifest: 42 },
      ]),
    ).toBe(false);
  });

  it('one current pack among stale/inert rows is enough', () => {
    expect(
      hasCurrentModalityConsent([
        { manifest, acceptedModalities: true, acceptedModalitiesChecksum: 'stale' },
        { manifest, acceptedModalities: true, acceptedModalitiesChecksum: currentChecksum },
      ]),
    ).toBe(true);
  });
});
