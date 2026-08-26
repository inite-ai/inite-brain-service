/**
 * memoryModel manifest section — the domain perception contract
 * (docs/domain-packs.md): validator matrix (caps, ids, referential
 * fences, anti-DSL), checksum/signature coverage, upgrade-diff flag, and
 * the MemoryModelReaderService mold (cache, invalidate, corrupted-section
 * fail-open).
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  diffPackUpgrade,
  packChecksum,
  signPack,
  validatePack,
  validateMemoryModel,
  verifyPackSignature,
  DomainPackError,
  MM_MAX_ATTENTION_HINTS,
  MM_MAX_RETENTION_HINTS,
  MM_MAX_SCENE_SCHEMAS,
  MM_MAX_STATE_MODELS,
  MM_MAX_VERIFICATION_RULES,
  type DomainPackManifest,
  type PackMemoryModel,
} from '../src/ai/domain-packs';
import { MemoryModelReaderService } from '../src/ai/memory-model-reader.service';
import type { SurrealService } from '../src/db/surreal.service';

function manifest(over: Partial<DomainPackManifest> = {}): DomainPackManifest {
  return {
    id: 'realty',
    version: '1.0.0',
    description: 'real-estate perception test pack',
    predicates: [
      {
        localId: 'deal_stage',
        displayLabel: 'deal stage',
        description: 'x',
        datatype: 'string',
        semantics: 'single_active',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
      {
        localId: 'asking_price',
        displayLabel: 'asking price',
        description: 'x',
        datatype: 'number',
        semantics: 'bitemporal',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
    ],
    ...over,
  };
}

function memoryModel(over: Partial<PackMemoryModel> = {}): PackMemoryModel {
  return {
    sceneSchemas: [
      { id: 'viewing', description: 'A property viewing.', cues: ['viewing', 'showed the flat'] },
    ],
    stateModels: [
      {
        id: 'deal_lifecycle',
        subjectType: 'deal',
        states: ['open', 'under_offer', 'closed'],
        transitions: [
          { from: 'open', to: 'under_offer' },
          { from: 'under_offer', to: 'closed' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'asking price', prefer: ['asking_price'], zoom: ['viewing', 'facts'], weight: 0.7 },
    ],
    verificationRules: [{ claimPattern: 'sold for', requires: 'corroboration' }],
    retentionHints: [
      { predicateOrScene: 'deal_stage', hint: 'durable' },
      { predicateOrScene: 'viewing', hint: 'standard' },
    ],
    ...over,
  };
}

const withMm = (mm: unknown) => manifest({ memoryModel: mm as PackMemoryModel });

describe('validateMemoryModel — the domain perception contract', () => {
  it('accepts a full, well-formed section via validatePack', () => {
    expect(() => validatePack(withMm(memoryModel()))).not.toThrow();
  });

  it('rejects a present-but-empty section (mcpTools mold)', () => {
    expect(() => validatePack(withMm({}))).toThrow(DomainPackError);
    expect(() => validatePack(withMm({ sceneSchemas: [] }))).toThrow(/non-empty/);
    expect(() => validatePack(withMm([]))).toThrow(/must be an object/);
    expect(() => validatePack(withMm('x'))).toThrow(DomainPackError);
  });

  it('enforces the per-list caps', () => {
    const scene = (i: number) => ({ id: `scene_${i}`, description: 'x' });
    expect(() =>
      validateMemoryModel(manifest(), {
        sceneSchemas: Array.from({ length: MM_MAX_SCENE_SCHEMAS + 1 }, (_, i) => scene(i)),
      }),
    ).toThrow(/max is 8/);
    expect(() =>
      validateMemoryModel(manifest(), {
        stateModels: Array.from({ length: MM_MAX_STATE_MODELS + 1 }, (_, i) => ({
          id: `m_${i}`,
          subjectType: 'deal',
          states: ['a', 'b'],
        })),
      }),
    ).toThrow(/max is 8/);
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: Array.from({ length: MM_MAX_ATTENTION_HINTS + 1 }, (_, i) => ({
          cue: `cue ${i}`,
        })),
      }),
    ).toThrow(/max is 16/);
    expect(() =>
      validateMemoryModel(manifest(), {
        verificationRules: Array.from({ length: MM_MAX_VERIFICATION_RULES + 1 }, () => ({
          requires: 'corroboration',
        })),
      }),
    ).toThrow(/max is 16/);
    expect(() =>
      validateMemoryModel(manifest(), {
        retentionHints: Array.from({ length: MM_MAX_RETENTION_HINTS + 1 }, () => ({
          predicateOrScene: 'deal_stage',
          hint: 'durable',
        })),
      }),
    ).toThrow(/max is 32/);
    expect(() =>
      validateMemoryModel(manifest(), {
        sceneSchemas: [{ id: 'v', description: 'x', cues: Array.from({ length: 13 }, () => 'aa') }],
      }),
    ).toThrow(/cues/);
  });

  it('enforces snake_case ids without the namespace separator', () => {
    expect(() =>
      validateMemoryModel(manifest(), { sceneSchemas: [{ id: 'Viewing', description: 'x' }] }),
    ).toThrow(/snake_case/);
    expect(() =>
      validateMemoryModel(manifest(), { sceneSchemas: [{ id: 'a__b', description: 'x' }] }),
    ).toThrow(/__/);
    expect(() =>
      validateMemoryModel(manifest(), {
        stateModels: [{ id: 'ok', subjectType: 'deal', states: ['Open', 'closed'] }],
      }),
    ).toThrow(/snake_case/);
  });

  it('rejects duplicate and cross-list-colliding ids', () => {
    expect(() =>
      validateMemoryModel(manifest(), {
        sceneSchemas: [
          { id: 'viewing', description: 'x' },
          { id: 'viewing', description: 'y' },
        ],
      }),
    ).toThrow(/duplicate sceneSchema/);
    expect(() =>
      validateMemoryModel(manifest(), {
        sceneSchemas: [{ id: 'viewing', description: 'x' }],
        stateModels: [{ id: 'viewing', subjectType: 'deal', states: ['a', 'b'] }],
      }),
    ).toThrow(/collides with a sceneSchema id/);
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: [{ cue: 'price' }, { cue: 'price' }],
      }),
    ).toThrow(/duplicate attentionHint cue/);
    expect(() =>
      validateMemoryModel(manifest(), {
        retentionHints: [
          { predicateOrScene: 'deal_stage', hint: 'durable' },
          { predicateOrScene: 'deal_stage', hint: 'ephemeral' },
        ],
      }),
    ).toThrow(/duplicate retentionHint/);
  });

  it('fences state transitions to declared states', () => {
    expect(() =>
      validateMemoryModel(manifest(), {
        stateModels: [
          {
            id: 'm',
            subjectType: 'deal',
            states: ['open', 'closed'],
            transitions: [{ from: 'open', to: 'ghost' }],
          },
        ],
      }),
    ).toThrow(/not a declared state/);
    expect(() =>
      validateMemoryModel(manifest(), {
        stateModels: [{ id: 'm', subjectType: 'deal', states: ['only_one'] }],
      }),
    ).toThrow(/2\.\.16/);
  });

  it('fences attentionHint.prefer to the pack’s OWN predicates (cross-pack reject)', () => {
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: [{ cue: 'price', prefer: ['other_pack_predicate'] }],
      }),
    ).toThrow(/not a predicate of this pack/);
    // A CORE predicate id is just as foreign as another pack's.
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: [{ cue: 'price', prefer: ['works_at'] }],
      }),
    ).toThrow(/not a predicate of this pack/);
  });

  it('fences zoom to own sceneSchemas plus the fixed literals', () => {
    const withScene = {
      sceneSchemas: [{ id: 'viewing', description: 'x' }],
    };
    expect(() =>
      validateMemoryModel(manifest(), {
        ...withScene,
        attentionHints: [{ cue: 'price', zoom: ['viewing', 'episodes', 'facts', 'scenes'] }],
      }),
    ).not.toThrow();
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: [{ cue: 'price', zoom: ['someone_elses_scene'] }],
      }),
    ).toThrow(/zoom target/);
    expect(() =>
      validateMemoryModel(manifest(), {
        attentionHints: [{ cue: 'price', zoom: ['facts', 'facts', 'facts', 'facts', 'facts'] }],
      }),
    ).toThrow(/1\.\.4/);
  });

  it('fences retentionHints to own predicates and scenes', () => {
    expect(() =>
      validateMemoryModel(manifest(), {
        retentionHints: [{ predicateOrScene: 'not_ours', hint: 'durable' }],
      }),
    ).toThrow(/neither a predicate localId nor a sceneSchema id/);
    expect(() =>
      validateMemoryModel(manifest(), {
        retentionHints: [{ predicateOrScene: 'deal_stage', hint: 'forever' }],
      }),
    ).toThrow(/ephemeral\|standard\|durable/);
  });

  it('anti-DSL: rejects template/DSL syntax and control chars in every free-text field', () => {
    for (const bad of ['{{name}}', 'a${x}b', 'a<%b%>', 'tick`tock', 'a|b', 'a\\b', 'a\u0000b']) {
      expect(() =>
        validateMemoryModel(manifest(), {
          sceneSchemas: [{ id: 'v', description: bad }],
        }),
      ).toThrow(DomainPackError);
      expect(() =>
        validateMemoryModel(manifest(), {
          sceneSchemas: [{ id: 'v', description: 'ok', cues: [bad] }],
        }),
      ).toThrow(DomainPackError);
      expect(() => validateMemoryModel(manifest(), { attentionHints: [{ cue: bad }] })).toThrow(
        DomainPackError,
      );
      expect(() =>
        validateMemoryModel(manifest(), {
          verificationRules: [{ claimPattern: bad, requires: 'corroboration' }],
        }),
      ).toThrow(DomainPackError);
    }
    // Length caps: cue 2..64, description 1..500, claimPattern 2..128.
    expect(() => validateMemoryModel(manifest(), { attentionHints: [{ cue: 'x' }] })).toThrow(
      /2\.\.64/,
    );
    expect(() =>
      validateMemoryModel(manifest(), {
        sceneSchemas: [{ id: 'v', description: 'x'.repeat(501) }],
      }),
    ).toThrow(/1\.\.500/);
    expect(() =>
      validateMemoryModel(manifest(), {
        verificationRules: [{ claimPattern: 'y'.repeat(129), requires: 'recency_check' }],
      }),
    ).toThrow(/2\.\.128/);
  });

  it('claimPattern additionally rejects regex metacharacters — literal substring, not a pattern', () => {
    for (const bad of ['a[b]', 'a(b)', 'a*b', 'a+b', 'a?b', '^ab', 'ab$']) {
      expect(() =>
        validateMemoryModel(manifest(), {
          verificationRules: [{ claimPattern: bad, requires: 'human_confirmation' }],
        }),
      ).toThrow(/literal substring, not a pattern/);
    }
    // The same characters stay legal in cues (they are matched literally
    // and carry no regex machinery) — only claimPattern gets the extra fence.
    expect(() =>
      validateMemoryModel(manifest(), { attentionHints: [{ cue: 'price (asking)' }] }),
    ).not.toThrow();
  });

  it('bounds attentionHint.weight to (0, 1]', () => {
    for (const bad of [0, -0.5, 1.5, NaN, 'high']) {
      expect(() =>
        validateMemoryModel(manifest(), { attentionHints: [{ cue: 'price', weight: bad }] }),
      ).toThrow(/\(0, 1\]/);
    }
    expect(() =>
      validateMemoryModel(manifest(), { attentionHints: [{ cue: 'price', weight: 1 }] }),
    ).not.toThrow();
  });

  it('rejects bad requires enum values', () => {
    expect(() =>
      validateMemoryModel(manifest(), { verificationRules: [{ requires: 'vibes' }] }),
    ).toThrow(/human_confirmation\|corroboration\|recency_check/);
  });
});

describe('memoryModel — checksum, signature, upgrade diff', () => {
  it('packChecksum flips when a single cue changes', () => {
    const a = withMm(memoryModel());
    const b = withMm(
      memoryModel({
        sceneSchemas: [
          { id: 'viewing', description: 'A property viewing.', cues: ['viewing', 'open house'] },
        ],
      }),
    );
    expect(packChecksum(a)).not.toBe(packChecksum(b));
    // Same content = same checksum (canonical JSON, key order irrelevant).
    expect(packChecksum(withMm(memoryModel()))).toBe(packChecksum(withMm(memoryModel())));
  });

  it('signature still verifies on a memoryModel-bearing manifest', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const m = { ...withMm(memoryModel()), publisher: 'acme' };
    const signed = { ...m, signature: signPack(m, priv) };
    expect(verifyPackSignature(signed, pub)).toBe(true);
    // The signature covers the section: tampering with one cue breaks it.
    const tampered = {
      ...signed,
      memoryModel: memoryModel({
        attentionHints: [{ cue: 'tampered cue' }],
      }),
    };
    expect(verifyPackSignature(tampered, pub)).toBe(false);
  });

  it('diffPackUpgrade.memoryModelChanged flips ONLY on a section change', () => {
    const prior = withMm(memoryModel());
    // Identical section → no flip (version bump alone is not a change).
    expect(
      diffPackUpgrade('realty', prior, { ...withMm(memoryModel()), version: '1.1.0' })
        .memoryModelChanged,
    ).toBe(false);
    // Both absent → no flip.
    expect(diffPackUpgrade('realty', manifest(), manifest()).memoryModelChanged).toBe(false);
    // One cue changed → flip.
    expect(
      diffPackUpgrade(
        'realty',
        prior,
        withMm(
          memoryModel({
            verificationRules: [{ claimPattern: 'sold for', requires: 'recency_check' }],
          }),
        ),
      ).memoryModelChanged,
    ).toBe(true);
    // Added / removed → flip.
    expect(diffPackUpgrade('realty', manifest(), prior).memoryModelChanged).toBe(true);
    expect(diffPackUpgrade('realty', prior, manifest()).memoryModelChanged).toBe(true);
  });
});

// ── MemoryModelReaderService (PackToolsReaderService mold) ──────────

type Row = { packId: string; version: string; manifest: DomainPackManifest };

function readerWith(rows: () => Promise<Row[]>): {
  reader: MemoryModelReaderService;
  calls: () => number;
} {
  let calls = 0;
  const fakeDb = {
    query: async () => {
      calls += 1;
      return [await rows()];
    },
  };
  const surreal = {
    withCompany: (_companyId: string, fn: (db: unknown) => unknown) => fn(fakeDb),
  } as unknown as SurrealService;
  return { reader: new MemoryModelReaderService(surreal), calls: () => calls };
}

describe('MemoryModelReaderService', () => {
  const row = (over: Partial<DomainPackManifest> = {}): Row => ({
    packId: 'realty',
    version: '1.0.0',
    manifest: withMm(memoryModel()),
    ...(Object.keys(over).length
      ? { manifest: manifest({ memoryModel: memoryModel(), ...over }) }
      : {}),
  });

  it('returns bindings for active memoryModel-bearing packs and caches them', async () => {
    const { reader, calls } = readerWith(async () => [row()]);
    const first = await reader.installedMemoryModels('co1');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ packId: 'realty', packVersion: '1.0.0' });
    expect(first[0]?.memoryModel.sceneSchemas?.[0]?.id).toBe('viewing');
    await reader.installedMemoryModels('co1');
    expect(calls()).toBe(1); // second read served from cache

    reader.invalidate('co1');
    await reader.installedMemoryModels('co1');
    expect(calls()).toBe(2); // invalidate forces a fresh load
  });

  it('defensively re-validates stored sections and skips corrupted ones', async () => {
    const corrupted: Row = {
      packId: 'broken',
      version: '2.0.0',
      manifest: withMm({ attentionHints: [{ cue: 'x{{evil}}' }] }),
    };
    const { reader } = readerWith(async () => [corrupted, row()]);
    const bindings = await reader.installedMemoryModels('co2');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.packId).toBe('realty'); // good row survives
  });

  it('fails open to [] on read errors', async () => {
    const { reader } = readerWith(async () => {
      throw new Error('db down');
    });
    await expect(reader.installedMemoryModels('co3')).resolves.toEqual([]);
  });
});
