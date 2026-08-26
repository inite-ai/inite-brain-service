/**
 * Media/biometric consent tier (Brain v2.1) — unit coverage:
 *  - media PII gate polarity (NONE blocked / [] open / class blocked /
 *    scope opens) — the deliberate flip vs the text `piiClass IS NONE`;
 *  - modality consent checksum matrix (fresh / carry-over / changed /
 *    removed), mirroring mcpConsentRequired semantics;
 *  - PIN: brain:read_media is OMITTED from jwks VALID_SCOPES (env-key
 *    only, never mintable) while env-key parsing accepts it;
 *  - PIN (conditional): the MediaPiiClass union matches the evidence
 *    substrate migration's ASSERT vocabulary once that migration lands;
 *  - raw-evidence per-call gate deny-overrides ladder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { ApiKeyService } from '../src/auth/api-key.service';
import { MEDIA_PII_CLASSES, mediaPiiAllowed, mediaPiiGate } from '../src/common/media-pii';
import {
  declaredModalitySection,
  modalitiesChecksum,
  modalityConsentRequired,
  rawEvidenceCapability,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import { gateRawEvidence } from '../src/mcp/raw-evidence-gate';

const READ_MEDIA = ['brain:read', 'brain:read_media'];
const PLAIN = ['brain:read', 'brain:read_pii'];

describe('mediaPiiGate — fail-closed polarity (flip vs text piiClass)', () => {
  it('without brain:read_media the fence admits ONLY affirmatively-clean rows', () => {
    expect(mediaPiiGate(PLAIN)).toBe(' AND piiClasses = []');
  });

  it('brain:read_media removes the fence entirely (sees unclassified + classified)', () => {
    expect(mediaPiiGate(READ_MEDIA)).toBe('');
  });

  it('read_pii does NOT open media rows — the tiers are not conflated', () => {
    expect(mediaPiiGate(['brain:read_pii'])).toBe(' AND piiClasses = []');
  });

  // JS twin — same table the SQL fragment enforces.
  it.each([
    // [piiClasses, scopes, allowed]
    [undefined, PLAIN, false], // NONE = unclassified → BLOCKED
    [null, PLAIN, false], // NONE = unclassified → BLOCKED
    [[], PLAIN, true], // [] = affirmatively clean → open
    [['face'], PLAIN, false], // classified → blocked without scope
    [['face'], READ_MEDIA, true], // scope opens classified
    [undefined, READ_MEDIA, true], // scope opens unclassified (no fence)
    [[], READ_MEDIA, true],
  ] as const)('mediaPiiAllowed(%j, %j) === %j', (piiClasses, scopes, allowed) => {
    expect(mediaPiiAllowed(piiClasses as string[] | null | undefined, [...scopes])).toBe(allowed);
  });
});

const manifest = (memoryModel?: Record<string, unknown>): DomainPackManifest =>
  ({
    id: 'media_pack',
    version: '1.0.0',
    description: 'Synthetic media pack (unit).',
    predicates: [],
    ...(memoryModel ? { memoryModel } : {}),
  }) as unknown as DomainPackManifest;

describe('declaredModalitySection — the defensive manifest probe', () => {
  it('returns null when nothing is declared (every existing pack — inert)', () => {
    expect(declaredModalitySection(manifest())).toBeNull();
  });

  it('returns null for a text-only declaration', () => {
    expect(declaredModalitySection(manifest({ modalities: ['text'] }))).toBeNull();
  });

  it('keeps non-text entries and drops text', () => {
    const s = declaredModalitySection(manifest({ modalities: ['text', 'image', 'audio'] }));
    expect(s).toEqual({ modalities: ['image', 'audio'] });
  });

  it('accepts the processors spelling and object entries', () => {
    const s = declaredModalitySection(
      manifest({ processors: [{ kind: 'text' }, { kind: 'image', model: 'x' }] }),
    );
    expect(s?.modalities).toEqual([{ kind: 'image', model: 'x' }]);
  });

  it('a raw-evidence declaration alone makes the section non-null', () => {
    const s = declaredModalitySection(manifest({ rawEvidence: { serve: true } }));
    expect(s).toEqual({ modalities: [], rawEvidence: { serve: true } });
    expect(rawEvidenceCapability(manifest({ rawEvidence: { serve: true } }))).toEqual({
      serve: true,
    });
    expect(rawEvidenceCapability(manifest({ modalities: ['image'] }))).toBeNull();
  });
});

describe('modalityConsentRequired — checksum matrix', () => {
  const declared = declaredModalitySection(
    manifest({ modalities: ['image'], rawEvidence: { serve: true } }),
  );
  const chk = modalitiesChecksum(declared);
  const base = { packId: 'media_pack', version: '1.0.0', declared };

  it('checksum is null iff nothing is declared', () => {
    expect(modalitiesChecksum(null)).toBeNull();
    expect(chk).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fresh install: declared without the flag → refusal naming the flag + modalities', () => {
    const msg = modalityConsentRequired({
      ...base,
      accepted: undefined,
      priorAccepted: false,
      priorChecksum: null,
    });
    expect(msg).toContain('acceptModalities');
    expect(msg).toContain('image');
    expect(msg).toContain('raw-evidence');
  });

  it('fresh install: flag grants consent', () => {
    expect(
      modalityConsentRequired({
        ...base,
        accepted: true,
        priorAccepted: false,
        priorChecksum: null,
      }),
    ).toBeNull();
  });

  it('carry-over: identical section needs no flag on upgrade', () => {
    expect(
      modalityConsentRequired({
        ...base,
        accepted: undefined,
        priorAccepted: true,
        priorChecksum: chk,
      }),
    ).toBeNull();
  });

  it('changed: a different stored checksum re-requires the flag (single trigger)', () => {
    const changed = declaredModalitySection(manifest({ modalities: ['image', 'audio'] }));
    expect(modalitiesChecksum(changed)).not.toBe(chk);
    const msg = modalityConsentRequired({
      ...base,
      declared: changed,
      accepted: undefined,
      priorAccepted: true,
      priorChecksum: chk,
    });
    expect(msg).toContain('acceptModalities');
  });

  it('removed: a manifest that drops the section needs no consent', () => {
    expect(
      modalityConsentRequired({
        packId: 'media_pack',
        version: '2.0.0',
        declared: null,
        accepted: undefined,
        priorAccepted: true,
        priorChecksum: chk,
      }),
    ).toBeNull();
  });
});

describe('brain:read_media scope — env-key only, never jwks-mintable', () => {
  it('PIN: jwks VALID_SCOPES omits brain:read_media (and still holds read_pii)', () => {
    const src = readFileSync(join(__dirname, '../src/auth/jwks.service.ts'), 'utf8');
    const block = /const VALID_SCOPES[\s\S]*?\]\);/.exec(src)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain("'brain:read_pii'");
    // The deliberate omission: media/biometric is a stricter regime than
    // read_pii; adding it here would make it mintable through the token
    // path and conflate the tiers. Env-key/introspection grants only.
    expect(block).not.toContain('brain:read_media');
  });

  it('env-key parsing (BRAIN_API_KEYS) accepts the scope', () => {
    const keyHash = ApiKeyService.hash('media-unit-key');
    const config = {
      get: () =>
        JSON.stringify([
          { keyHash, companyId: 'co_media_unit', scopes: ['brain:read', 'brain:read_media'] },
        ]),
    } as unknown as ConfigService;
    const svc = new ApiKeyService(config);
    svc.onModuleInit();
    const rec = svc.resolve('media-unit-key');
    expect(rec?.scopes).toContain('brain:read_media');
  });
});

describe('MediaPiiClass union vs evidence-substrate migration vocabulary (conditional pin)', () => {
  // The evidence substrate (evidence_asset / evidence_fragment) lands in a
  // sibling PR whose migrations ASSERT a piiClasses vocabulary matching
  // MEDIA_PII_CLASSES. Until it merges there is nothing to pin — skip
  // gracefully; once a migration mentioning both an evidence table and
  // piiClasses exists, this test locks the two vocabularies together
  // (src/common/media-pii.ts is canonical on drift).
  const migrationsDir = join(__dirname, '../src/db/migrations');
  const evidenceMigration = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.surql'))
    .map((f) => ({ f, text: readFileSync(join(migrationsDir, f), 'utf8') }))
    .find(({ text }) => /evidence_(asset|fragment)/.test(text) && text.includes('piiClasses'));

  (evidenceMigration ? it : it.skip)('migration ASSERT vocabulary === MediaPiiClass union', () => {
    const { text } = evidenceMigration as { f: string; text: string };
    const assertStmt = /piiClasses[^;]*ASSERT[^;]*;/s.exec(text)?.[0] ?? '';
    const vocab = [...assertStmt.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(vocab)).toEqual(new Set(MEDIA_PII_CLASSES));
  });
});

describe('gateRawEvidence — deny-overrides ladder', () => {
  const rawManifest = manifest({ modalities: ['image'], rawEvidence: { serve: true } });
  const currentChk = modalitiesChecksum(declaredModalitySection(rawManifest));
  const consented = {
    manifest: rawManifest,
    acceptedModalities: true,
    acceptedModalitiesChecksum: currentChk,
  };

  it('(a) denies when the pack declares no raw-evidence capability', () => {
    const d = gateRawEvidence({
      manifest: manifest({ modalities: ['image'] }),
      acceptedModalities: true,
      acceptedModalitiesChecksum: modalitiesChecksum(
        declaredModalitySection(manifest({ modalities: ['image'] })),
      ),
      callerScopes: READ_MEDIA,
      fragmentPiiClasses: [],
    });
    expect(d).toEqual({ allowed: false, reason: expect.stringContaining('raw-evidence') });
  });

  it('(b) denies without consent, and on a stale checksum', () => {
    for (const row of [
      { acceptedModalities: false, acceptedModalitiesChecksum: currentChk },
      { acceptedModalities: true, acceptedModalitiesChecksum: 'deadbeef' },
      { acceptedModalities: true, acceptedModalitiesChecksum: null },
    ]) {
      const d = gateRawEvidence({
        manifest: rawManifest,
        ...row,
        callerScopes: READ_MEDIA,
        fragmentPiiClasses: [],
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain('consent');
    }
  });

  it('(c) fragment gate: unclassified and classified both deny without the scope', () => {
    const unclassified = gateRawEvidence({
      ...consented,
      callerScopes: PLAIN,
      fragmentPiiClasses: undefined,
    });
    expect(unclassified).toEqual({
      allowed: false,
      reason: expect.stringContaining('unclassified'),
    });
    const classified = gateRawEvidence({
      ...consented,
      callerScopes: PLAIN,
      fragmentPiiClasses: ['face'],
    });
    expect(classified).toEqual({
      allowed: false,
      reason: expect.stringContaining('brain:read_media'),
    });
  });

  it('allows affirmatively-clean fragments, and classified ones for the scope', () => {
    expect(gateRawEvidence({ ...consented, callerScopes: PLAIN, fragmentPiiClasses: [] })).toEqual({
      allowed: true,
    });
    expect(
      gateRawEvidence({
        ...consented,
        callerScopes: READ_MEDIA,
        fragmentPiiClasses: ['face', 'voice'],
      }),
    ).toEqual({ allowed: true });
  });
});
