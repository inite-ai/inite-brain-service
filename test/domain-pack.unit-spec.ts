/**
 * Domain Pack standard — manifest validation + seed assembly (namespacing,
 * collision detection) + the code-memory pack wiring.
 */
import {
  assembleSeed,
  composePredicateId,
  declaredModalitySection,
  diffPackUpgrade,
  modalitiesChecksum,
  modalityConsentRequired,
  packChecksum,
  validatePack,
  DomainPackError,
  FIRST_PARTY_PACKS,
  SEED_DOC_MAX_CHARS,
  SEED_MAX_DOCS,
  SEED_TOTAL_MAX_CHARS,
  type DomainPackManifest,
  type PackMemoryModality,
  type PackPredicate,
  type PackSeedDocument,
} from '../src/ai/domain-packs';
import type { EvidenceModality } from '../src/common/evidence-taxonomy';
import { gateProcessorDispatch } from '../src/evidence/processing/dispatch-gate';
import { gateRawEvidence } from '../src/mcp/raw-evidence-gate';
import { computeHash } from '../src/ai/predicate-registry-internals/db-mapping';
import {
  CODE_MEMORY_PACK,
  CODE_MEMORY_PREDICATE_IDS,
  codeMemoryKindOf,
  codeMemoryPredicateId,
  SEED_PREDICATES,
} from '../src/ai/domain-packs';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';

function packPredicate(localId: string): PackPredicate {
  return {
    localId,
    displayLabel: localId,
    description: 'x',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
  };
}
function pack(over: Partial<DomainPackManifest>): DomainPackManifest {
  return {
    id: 'demo',
    version: '0.1.0',
    description: 'demo',
    predicates: [packPredicate('thing')],
    ...over,
  };
}
function corePredicate(predicateId: string): PredicateDefinition {
  return {
    predicateId,
    displayLabel: predicateId,
    description: 'x',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  };
}

describe('validatePack', () => {
  it('accepts a well-formed pack', () => {
    expect(() => validatePack(pack({}))).not.toThrow();
  });
  it('rejects a non-snake_case pack id', () => {
    expect(() => validatePack(pack({ id: 'Demo-Pack' }))).toThrow(DomainPackError);
  });
  it('rejects a pack id containing the namespace separator', () => {
    expect(() => validatePack(pack({ id: 'a__b' }))).toThrow(/__/);
  });
  it('rejects a non-semver version', () => {
    expect(() => validatePack(pack({ version: '1.0' }))).toThrow(/semver/);
  });
  it('rejects an empty predicate set', () => {
    expect(() => validatePack(pack({ predicates: [] }))).toThrow(/no predicates/);
  });
  it('rejects duplicate localIds', () => {
    expect(() =>
      validatePack(pack({ predicates: [packPredicate('x'), packPredicate('x')] })),
    ).toThrow(/duplicate/);
  });
  it('rejects a localId containing the separator', () => {
    expect(() => validatePack(pack({ predicates: [packPredicate('a__b')] }))).toThrow(
      DomainPackError,
    );
  });
  it('rejects a pack id ending in underscore (uninstall-prefix collision)', () => {
    expect(() => validatePack(pack({ id: 'foo_' }))).toThrow(/underscore/);
  });
  it('rejects a bad semantics enum (would be a DB ASSERT 500 mid-install)', () => {
    const bad = { ...packPredicate('x'), semantics: 'sometimes' as never };
    expect(() => validatePack(pack({ predicates: [bad] }))).toThrow(/semantics/);
  });
  it('rejects a bad piiClass enum', () => {
    const bad = { ...packPredicate('x'), piiClass: 'secret' as never };
    expect(() => validatePack(pack({ predicates: [bad] }))).toThrow(/piiClass/);
  });
  it('rejects a non-array predicates field', () => {
    expect(() => validatePack(pack({ predicates: 42 as never }))).toThrow(/must be an array/);
  });
  it('accepts a well-formed extractionProfile', () => {
    expect(() =>
      validatePack(
        pack({
          extractionProfile: {
            guidance: 'read this domain carefully',
            fewShot: [{ text: 'sample', note: 'what to extract' }],
          },
        }),
      ),
    ).not.toThrow();
  });
  it('rejects a non-string extractionProfile.guidance', () => {
    expect(() =>
      validatePack(pack({ extractionProfile: { guidance: 42 as unknown as string } })),
    ).toThrow(/guidance must be a string/);
  });
  it('rejects a malformed extractionProfile.fewShot entry', () => {
    expect(() =>
      validatePack(
        pack({
          extractionProfile: {
            fewShot: [{ text: 'ok' } as unknown as { text: string; note: string }],
          },
        }),
      ),
    ).toThrow(/fewShot entries must be/);
  });
});

describe('validateSeedDocuments (via validatePack)', () => {
  function seed(over: Partial<PackSeedDocument> = {}): PackSeedDocument {
    return {
      localId: 'primer',
      title: 'Domain primer',
      text: 'Some seed knowledge.',
      vertical: 'demo',
      ...over,
    };
  }

  it('accepts a well-formed seed document set', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [
            seed({
              originUri: 'https://example.com/primer',
              occurredAt: '2026-01-01T00:00:00Z',
              meta: { audience: 'agents', priority: 2, curated: true },
            }),
            seed({ localId: 'glossary' }),
          ],
        }),
      ),
    ).not.toThrow();
  });
  it('rejects duplicate seed localIds', () => {
    expect(() => validatePack(pack({ seedDocuments: [seed(), seed()] }))).toThrow(
      /duplicate seed document localId/,
    );
  });
  it('rejects a non-snake_case seed localId', () => {
    expect(() => validatePack(pack({ seedDocuments: [seed({ localId: 'Primer-1' })] }))).toThrow(
      DomainPackError,
    );
  });
  it('rejects a seed localId containing the namespace separator', () => {
    expect(() => validatePack(pack({ seedDocuments: [seed({ localId: 'a__b' })] }))).toThrow(/__/);
  });
  it('rejects a seed text over the per-document cap', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [seed({ text: 'x'.repeat(SEED_DOC_MAX_CHARS + 1) })],
        }),
      ),
    ).toThrow(/per-document cap/);
  });
  it('rejects seed texts over the combined cap', () => {
    const chunk = 'x'.repeat(SEED_DOC_MAX_CHARS);
    const docs = Array.from(
      { length: Math.ceil(SEED_TOTAL_MAX_CHARS / SEED_DOC_MAX_CHARS) + 1 },
      (_, i) => seed({ localId: `doc_${i}`, text: chunk }),
    );
    expect(() => validatePack(pack({ seedDocuments: docs }))).toThrow(/chars of text combined/);
  });
  it('rejects a seed without a vertical', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [seed({ vertical: undefined as unknown as string })],
        }),
      ),
    ).toThrow(/vertical/);
  });
  it('rejects an unparseable occurredAt', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed({ occurredAt: 'yesterday' })] })),
    ).toThrow(/occurredAt/);
  });
  it('rejects non-scalar meta values', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [
            seed({
              meta: { nested: { deep: true } } as unknown as NonNullable<PackSeedDocument['meta']>,
            }),
          ],
        }),
      ),
    ).toThrow(/meta value/);
  });
  it('rejects a non-snake_case meta key', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed({ meta: { 'Bad-Key': 'x' } })] })),
    ).toThrow(/meta key/);
  });
  it(`rejects more than ${SEED_MAX_DOCS} seed documents`, () => {
    const docs = Array.from({ length: SEED_MAX_DOCS + 1 }, (_, i) => seed({ localId: `doc_${i}` }));
    expect(() => validatePack(pack({ seedDocuments: docs }))).toThrow(/the cap is/);
  });
  it('changes the pack checksum when a seed text changes', () => {
    const a = pack({ seedDocuments: [seed({ text: 'version one' })] });
    const b = pack({ seedDocuments: [seed({ text: 'version two' })] });
    expect(packChecksum(a)).not.toBe(packChecksum(b));
  });
});

describe('assembleSeed', () => {
  it('namespaces pack predicates and keeps core unchanged', () => {
    const core = [corePredicate('name')];
    const merged = assembleSeed(core, [pack({ id: 'demo', predicates: [packPredicate('thing')] })]);
    const ids = merged.map((p) => p.predicateId);
    expect(ids).toContain('name');
    expect(ids).toContain('demo__thing');
    expect(merged.find((p) => p.predicateId === 'demo__thing')?.createdBy).toBe('system');
  });

  it('throws on a pack-vs-pack id collision', () => {
    expect(() =>
      assembleSeed(
        [],
        [
          pack({ id: 'dup', predicates: [packPredicate('x')] }),
          pack({ id: 'dup', predicates: [packPredicate('x')] }),
        ],
      ),
    ).toThrow(/collision/);
  });

  it('throws on a pack-vs-core id collision', () => {
    expect(() =>
      assembleSeed([corePredicate('p__x')], [pack({ id: 'p', predicates: [packPredicate('x')] })]),
    ).toThrow(/collision/);
  });
});

describe('packChecksum', () => {
  it('is deterministic and independent of key order', () => {
    const a = pack({ id: 'demo', version: '1.2.3' });
    const b = { version: '1.2.3', predicates: a.predicates, description: 'demo', id: 'demo' };
    expect(packChecksum(a)).toBe(packChecksum(b as DomainPackManifest));
  });
  it('changes when content changes', () => {
    const a = pack({ version: '1.0.0' });
    const c = pack({ version: '1.0.1' });
    expect(packChecksum(a)).not.toBe(packChecksum(c));
  });
});

describe('diffPackUpgrade', () => {
  it('detects a redefined predicate (piiClass change) as changed', () => {
    const prior = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const bumped = {
      ...packPredicate('dx'),
      piiClass: 'sensitive' as const,
    };
    const next = pack({ id: 'med', predicates: [bumped] });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.predicateId).toBe('med__dx');
    expect(changed[0]!.piiClass).toBe('sensitive');
    expect(changed[0]!.createdBy).toBe('admin');
    expect(removedIds).toEqual([]);
  });

  it('flags a predicate dropped by the new manifest as removed', () => {
    const prior = pack({
      id: 'med',
      predicates: [packPredicate('dx'), packPredicate('rx')],
    });
    const next = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual(['med__rx']);
  });

  it('leaves genuinely new predicates to seedMissingPredicates (not "changed")', () => {
    const prior = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const next = pack({
      id: 'med',
      predicates: [packPredicate('dx'), packPredicate('rx')],
    });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it('is a no-op when the manifest is unchanged', () => {
    const p = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', p, p);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it('treats an absent prior manifest as all-additions', () => {
    const next = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', undefined, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });
});

describe('computeHash', () => {
  const preds = [corePredicate('name')];
  it('folds extraction profiles into the hash (profile-only change busts it)', () => {
    const bare = computeHash(preds);
    const withProfile = computeHash(preds, [{ packId: 'med', profile: { guidance: 'v1' } }]);
    const withProfileV2 = computeHash(preds, [{ packId: 'med', profile: { guidance: 'v2' } }]);
    expect(withProfile).not.toBe(bare);
    expect(withProfileV2).not.toBe(withProfile);
  });
  it('is stable regardless of profile order', () => {
    const a = computeHash(preds, [
      { packId: 'a', profile: { guidance: 'x' } },
      { packId: 'b', profile: { guidance: 'y' } },
    ]);
    const b = computeHash(preds, [
      { packId: 'b', profile: { guidance: 'y' } },
      { packId: 'a', profile: { guidance: 'x' } },
    ]);
    expect(a).toBe(b);
  });
  it('empty profiles === omitted profiles (byte-identical, no-op for profileless tenants)', () => {
    expect(computeHash(preds, [])).toBe(computeHash(preds));
  });
});

describe('composePredicateId', () => {
  it('joins with the double-underscore separator', () => {
    expect(composePredicateId('code_memory', 'decided')).toBe('code_memory__decided');
  });
});

describe('code-memory pack', () => {
  it('is a valid pack', () => {
    expect(() => validatePack(CODE_MEMORY_PACK)).not.toThrow();
  });
  it('exposes namespaced predicate ids + round-trips kindOf', () => {
    expect(codeMemoryPredicateId('decided')).toBe('code_memory__decided');
    expect(codeMemoryKindOf('code_memory__gotcha')).toBe('gotcha');
    expect(CODE_MEMORY_PREDICATE_IDS).toContain('code_memory__invariant');
  });
  it('is merged into SEED_PREDICATES (namespaced, not bare)', () => {
    const ids = SEED_PREDICATES.map((p) => p.predicateId);
    expect(ids).toContain('code_memory__decided');
    expect(ids).not.toContain('decided');
    // core predicates still present
    expect(ids).toContain('name');
  });

  // ── 0.4.0: extractionProfile + ontology increment + memoryModel ────
  it('seeds the 0.4.0 ontology increment alongside the original four kinds', () => {
    const ids = SEED_PREDICATES.map((p) => p.predicateId);
    for (const local of ['owns', 'default_value', 'depends_on_version', 'superseded_by']) {
      expect(ids).toContain(`code_memory__${local}`);
    }
    // The original decision-journal kinds are untouched.
    for (const local of ['decided', 'because', 'invariant', 'gotcha']) {
      expect(ids).toContain(`code_memory__${local}`);
    }
  });

  it('revisioned vs trail semantics: defaults/pins/ownership supersede, supersession appends', () => {
    const byLocal = new Map(CODE_MEMORY_PACK.predicates.map((p) => [p.localId, p]));
    expect(byLocal.get('default_value')?.semantics).toBe('single_active');
    expect(byLocal.get('depends_on_version')?.semantics).toBe('single_active');
    expect(byLocal.get('owns')?.semantics).toBe('single_active');
    expect(byLocal.get('superseded_by')?.semantics).toBe('append_only');
    // The originals keep the semantics they shipped with.
    expect(byLocal.get('decided')?.semantics).toBe('single_active');
    expect(byLocal.get('because')?.semantics).toBe('append_only');
    expect(byLocal.get('invariant')?.semantics).toBe('single_active');
    expect(byLocal.get('gotcha')?.semantics).toBe('append_only');
  });

  it('ships a SELF-SCOPING extractionProfile (builtin = injected into every tenant)', () => {
    const profile = CODE_MEMORY_PACK.extractionProfile;
    expect(profile?.guidance).toContain('ONLY when the input discusses software work');
    expect(profile?.guidance).toContain('contributes NOTHING');
    // Identifier-shaped subjects become their own entities, never the speaker.
    expect(profile?.guidance).toContain('NEVER the speaker');
    expect(profile?.fewShot?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  // 0.4.1 (k13 battery finding): ownership phrasing must be covered by a
  // DEDICATED few-shot — person-first "NAME owns PATH" with an
  // enumeration tail — and the guidance must spell out the
  // subject/value inversion, so open-vocab extraction canonicalizes
  // ownership turns into code_memory__owns instead of coining.
  it('covers ownership phrasing: dedicated fewShot + inversion guidance', () => {
    const profile = CODE_MEMORY_PACK.extractionProfile;
    const ownershipExamples = (profile?.fewShot ?? []).filter((ex) =>
      ex.note.includes('code_memory__owns'),
    );
    // The dedicated example plus the original compound one.
    expect(ownershipExamples.length).toBeGreaterThanOrEqual(2);
    expect(
      ownershipExamples.some((ex) => /\bowns src\/\S+ in \S+, including\b/.test(ex.text)),
    ).toBe(true);
    expect(profile?.guidance).toContain('the VALUE of code_memory__owns');
  });

  // 0.4.2 (k10 battery finding): a module referenced by file path and by
  // the symbol it defines must be ONE entity with the path as canonical
  // subject — the guidance spells it out and a dedicated few-shot covers
  // the symbol phrasing, so open-vocab extraction stops minting a
  // per-phrasing twin.
  it('0.4.2: file path and defined symbol are ONE entity, path canonical', () => {
    const profile = CODE_MEMORY_PACK.extractionProfile;
    expect(profile?.guidance).toContain('ONE entity');
    expect(profile?.guidance).toContain('canonical subject for BOTH phrasings');
    const identityExamples = (profile?.fewShot ?? []).filter((ex) =>
      ex.note.includes('ONE entity'),
    );
    expect(identityExamples.length).toBeGreaterThanOrEqual(1);
    // The example pairs a PascalCase symbol with the path that defines it.
    expect(
      identityExamples.some(
        (ex) => /[A-Z][a-z]+[A-Z][a-z]+/.test(ex.text) && /src\/\S+\.\w+/.test(ex.text),
      ),
    ).toBe(true);
  });

  // 0.4.3 (k10 battery finding, run cmmtq1z412): a compound "X, never Y"
  // invariant was split in two and its value-shaped-looking fragment
  // mis-slotted as code_memory__default_value. The profile must carry a
  // dedicated few-shot keeping a two-clause invariant ONE fact, and the
  // guidance + predicate description must confine default_value to
  // value-shaped defaults (number/boolean/enum token of a NAMED
  // flag/config) — never prose fragments.
  it('0.4.3: compound invariant stays ONE fact; default_value is value-shaped only', () => {
    const profile = CODE_MEMORY_PACK.extractionProfile;
    // Guidance: default_value confined to value tokens, compound invariants unsplit.
    expect(profile?.guidance).toContain('ONLY value-shaped defaults');
    expect(profile?.guidance).toContain('NEVER a prose fragment');
    expect(profile?.guidance).toContain('never split its clauses');
    // A dedicated few-shot shows a two-clause invariant landing as ONE
    // invariant fact with BOTH clauses verbatim, and forbids routing the
    // value-shaped-looking fragment into default_value.
    const compound = (profile?.fewShot ?? []).filter(
      (ex) =>
        /, never /.test(ex.text) &&
        ex.note.includes('code_memory__invariant') &&
        ex.note.includes('NOT') &&
        ex.note.includes('code_memory__default_value'),
    );
    expect(compound.length).toBeGreaterThanOrEqual(1);
    // The predicate description itself fences out prose fragments.
    const defaultValue = CODE_MEMORY_PACK.predicates.find((p) => p.localId === 'default_value');
    expect(defaultValue?.description).toContain('NOT FOR prose fragments');
    expect(defaultValue?.description).toContain('value-shaped');
  });

  it('declares the perception contract: three lifecycles, hints, one recency rule', () => {
    const mm = CODE_MEMORY_PACK.memoryModel;
    expect(mm?.stateModels?.map((m) => m.id).sort()).toEqual([
      'change_lifecycle',
      'dependency_lifecycle',
      'flag_lifecycle',
    ]);
    const flag = mm?.stateModels?.find((m) => m.id === 'flag_lifecycle');
    expect(flag?.states).toEqual(['declared', 'enabled', 'deprecated', 'removed']);
    expect(mm?.attentionHints?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(mm?.verificationRules).toEqual([{ claimPattern: 'default', requires: 'recency_check' }]);
    expect(mm?.retentionHints?.some((h) => h.predicateOrScene === 'gotcha')).toBe(true);
  });

  it('eval fixtures cover every 0.4.0 predicate and resolve against declared localIds', () => {
    const locals = new Set(CODE_MEMORY_PACK.predicates.map((p) => p.localId));
    const fixtures = CODE_MEMORY_PACK.evalFixtures ?? [];
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    const asserted = new Set<string>();
    for (const f of fixtures) {
      for (const want of f.expect.facts ?? []) {
        expect(locals.has(want.predicate)).toBe(true);
        asserted.add(want.predicate);
      }
    }
    for (const local of ['owns', 'default_value', 'depends_on_version', 'superseded_by']) {
      expect(asserted.has(local)).toBe(true);
    }
  });
});

// ── Media contract: modalities / processors / rawEvidence ────────────────
//
// Before these declarations every first-party pack was text-only, which
// meant FOUR consumers denied unconditionally: gateProcessorDispatch, the
// processor broker behind it, gateRawEvidence, and the raw-read gateway +
// signed-URL mint that call it. The pins below are the contract each pack
// now offers; the gate block after them proves the consumers came alive.

/** The two capabilities an installed adapter can actually run today. */
const IMAGE_METADATA = { id: 'image_metadata', modality: 'image', produces: ['caption'] };
const DOCUMENT_TEXT = { id: 'document_text', modality: 'document', produces: ['text'] };

interface MediaExpectation {
  pack: DomainPackManifest;
  version: string;
  modalities: PackMemoryModality[];
  processors: Array<{ id: string; modality: string; produces: string[] }>;
  /** undefined = raw serving DENIED (the schema's conservative setting). */
  rawEvidence: { serve: true } | undefined;
}

const MEDIA_CONTRACT: MediaExpectation[] = [
  {
    pack: packById('real_estate'),
    version: '0.3.0',
    modalities: ['text', 'image', 'document'],
    processors: [IMAGE_METADATA, DOCUMENT_TEXT],
    // Listing media is published marketing material — the one pack that serves raw.
    rawEvidence: { serve: true },
  },
  {
    pack: packById('medical'),
    version: '0.3.0',
    modalities: ['text', 'image', 'document'],
    processors: [IMAGE_METADATA, DOCUMENT_TEXT],
    rawEvidence: undefined, // clinical imaging never serves raw
  },
  {
    pack: packById('insurance'),
    version: '0.3.0',
    modalities: ['text', 'image', 'document'],
    processors: [IMAGE_METADATA, DOCUMENT_TEXT],
    rawEvidence: undefined, // claim photos carry third-party personal data
  },
  {
    pack: packById('legal'),
    version: '0.3.0',
    modalities: ['text', 'image', 'document'],
    processors: [DOCUMENT_TEXT, IMAGE_METADATA],
    rawEvidence: undefined, // exhibits carry privilege
  },
  {
    pack: packById('fintech'),
    version: '0.3.0',
    modalities: ['text', 'document'],
    processors: [DOCUMENT_TEXT],
    rawEvidence: undefined, // statements / KYC files
  },
  {
    pack: packById('hr'),
    version: '0.3.0',
    modalities: ['text', 'document'],
    processors: [DOCUMENT_TEXT],
    rawEvidence: undefined, // CVs are personal data
  },
  {
    pack: CODE_MEMORY_PACK,
    version: '0.5.0',
    modalities: ['text', 'image', 'document'],
    processors: [IMAGE_METADATA, DOCUMENT_TEXT],
    rawEvidence: undefined, // a builtin seeds into every tenant unasked
  },
];

function packById(id: string): DomainPackManifest {
  const found = FIRST_PARTY_PACKS.find((p) => p.id === id);
  if (!found) throw new Error(`no first-party pack "${id}"`);
  return found;
}

describe.each(MEDIA_CONTRACT.map((e) => [e.pack.id, e] as const))(
  'media contract: %s',
  (_id, expected) => {
    const mm = expected.pack.memoryModel;

    it('is at the media-contract minor version', () => {
      expect(expected.pack.version).toBe(expected.version);
    });

    it('declares the pinned modalities / processors / rawEvidence', () => {
      expect(mm?.modalities).toEqual(expected.modalities);
      expect(mm?.processors).toEqual(expected.processors);
      expect(mm?.rawEvidence).toEqual(expected.rawEvidence);
    });

    it('requests ONLY capabilities an installed adapter can run', () => {
      // ImageMetadataStubAdapter (image→caption) and
      // TextExtractionPassthroughAdapter (document→text) are the whole
      // installed set. Declaring ocr/asr/vision-caption would arm a
      // capability that always denies at dispatch.
      for (const processor of mm?.processors ?? []) {
        expect(['image', 'document']).toContain(processor.modality);
        for (const kind of processor.produces) {
          expect(['caption', 'text']).toContain(kind);
        }
      }
      const kinds = (mm?.processors ?? []).flatMap((p) => p.produces);
      for (const unbuilt of ['ocr', 'asr', 'object_track', 'scene_graph', 'embedding']) {
        expect(kinds).not.toContain(unbuilt);
      }
    });

    it('never requests a processor for an undeclared input modality', () => {
      for (const processor of mm?.processors ?? []) {
        expect(mm?.modalities).toContain(processor.modality);
      }
    });

    it('is a CONSENT SURFACE — install requires acceptModalities: true', () => {
      // Non-text declarations make declaredModalitySection non-null, which
      // is exactly what modalityConsentRequired keys off.
      const section = declaredModalitySection(expected.pack);
      expect(section).not.toBeNull();
      expect(section?.modalities).not.toContain('text');
      expect(
        modalityConsentRequired({
          packId: expected.pack.id,
          version: expected.pack.version,
          declared: section,
          accepted: undefined,
          priorAccepted: false,
          priorChecksum: null,
        }),
      ).toContain('acceptModalities: true');
      expect(modalitiesChecksum(section)).toEqual(expect.any(String));
    });
  },
);

describe('the media gates came alive (they denied every pack before)', () => {
  const REAL_ESTATE = packById('real_estate');
  const MEDICAL = packById('medical');
  const FINTECH = packById('fintech');

  /** A tenant that installed the pack with acceptModalities: true. */
  const consent = (manifest: DomainPackManifest) => ({
    manifest,
    acceptedModalities: true,
    acceptedModalitiesChecksum: modalitiesChecksum(declaredModalitySection(manifest)),
  });
  const asset = (modality: EvidenceModality) => ({ modality, availability: 'hot' });

  describe('gateProcessorDispatch', () => {
    it('ADMITS image→caption for a pack that declares the image processor', () => {
      expect(
        gateProcessorDispatch({
          ...consent(REAL_ESTATE),
          capability: 'caption',
          asset: asset('image'),
        }),
      ).toEqual({ allowed: true });
    });

    it('ADMITS document→text for a document-only pack', () => {
      expect(
        gateProcessorDispatch({
          ...consent(FINTECH),
          capability: 'text',
          asset: asset('document'),
        }),
      ).toEqual({ allowed: true });
    });

    it('DENIES image→caption for a pack that declares no image modality', () => {
      const d = gateProcessorDispatch({
        ...consent(FINTECH),
        capability: 'caption',
        asset: asset('image'),
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain('does not declare');
    });

    it('DENIES an unbuilt capability (ocr) on a declared modality', () => {
      const d = gateProcessorDispatch({
        ...consent(MEDICAL),
        capability: 'ocr',
        asset: asset('document'),
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain('does not declare');
    });

    it('DENIES without the operator consent flag, however good the declaration', () => {
      const d = gateProcessorDispatch({
        manifest: REAL_ESTATE,
        acceptedModalities: false,
        acceptedModalitiesChecksum: null,
        capability: 'caption',
        asset: asset('image'),
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain('acceptModalities: true');
    });
  });

  describe('gateRawEvidence', () => {
    it('ADMITS an affirmatively-clean fragment for the one pack that serves raw', () => {
      expect(
        gateRawEvidence({
          ...consent(REAL_ESTATE),
          callerScopes: ['brain:read'],
          fragmentPiiClasses: [],
        }),
      ).toEqual({ allowed: true });
    });

    it('DENIES every pack that omits rawEvidence (omission = deny)', () => {
      for (const expected of MEDIA_CONTRACT.filter((e) => e.rawEvidence === undefined)) {
        const d = gateRawEvidence({
          ...consent(expected.pack),
          callerScopes: ['brain:read', 'brain:read_media'],
          fragmentPiiClasses: [],
        });
        expect(d.allowed).toBe(false);
        if (!d.allowed) expect(d.reason).toContain('does not declare the raw-evidence capability');
      }
    });

    it('still fails closed on an unclassified fragment for the serving pack', () => {
      const d = gateRawEvidence({
        ...consent(REAL_ESTATE),
        callerScopes: ['brain:read'],
        fragmentPiiClasses: null,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain('unclassified');
    });

    it('still needs brain:read_media for a classified fragment', () => {
      const d = gateRawEvidence({
        ...consent(REAL_ESTATE),
        callerScopes: ['brain:read'],
        fragmentPiiClasses: ['face'],
      });
      expect(d.allowed).toBe(false);
      expect(
        gateRawEvidence({
          ...consent(REAL_ESTATE),
          callerScopes: ['brain:read', 'brain:read_media'],
          fragmentPiiClasses: ['face'],
        }),
      ).toEqual({ allowed: true });
    });
  });
});
