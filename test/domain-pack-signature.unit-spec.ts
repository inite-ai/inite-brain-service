/**
 * Domain Pack signatures — ed25519 sign/verify + install trust policy.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  assertPackTrust,
  signPack,
  verifyPackSignature,
  DomainPackError,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function manifest(over: Partial<DomainPackManifest> = {}): DomainPackManifest {
  return {
    id: 'medical',
    version: '1.0.0',
    description: 'medical',
    predicates: [
      {
        localId: 'diagnosis',
        displayLabel: 'diagnosis',
        description: 'x',
        datatype: 'string',
        semantics: 'append_only',
        decayHalfLifeDays: null,
        piiClass: 'sensitive',
        status: 'active',
      },
    ],
    ...over,
  };
}

describe('signPack / verifyPackSignature', () => {
  it('round-trips a valid signature', () => {
    const { pub, priv } = keypair();
    const m = manifest();
    m.signature = signPack(m, priv);
    expect(verifyPackSignature(m, pub)).toBe(true);
  });

  it('fails when the manifest is tampered after signing', () => {
    const { pub, priv } = keypair();
    const m = manifest();
    m.signature = signPack(m, priv);
    m.version = '9.9.9';
    expect(verifyPackSignature(m, pub)).toBe(false);
  });

  it('fails against a different public key', () => {
    const a = keypair();
    const b = keypair();
    const m = manifest();
    m.signature = signPack(m, a.priv);
    expect(verifyPackSignature(m, b.pub)).toBe(false);
  });
});

describe('assertPackTrust', () => {
  it('allows an unsigned pack when signatures are not required', () => {
    expect(() =>
      assertPackTrust({ manifest: manifest(), trustedKeys: {}, requireSignature: false }),
    ).not.toThrow();
  });

  it('rejects an unsigned pack when signatures are required', () => {
    expect(() =>
      assertPackTrust({ manifest: manifest(), trustedKeys: {}, requireSignature: true }),
    ).toThrow(DomainPackError);
  });

  it('accepts a valid signature from a trusted publisher', () => {
    const { pub, priv } = keypair();
    const m = manifest({ publisher: 'acme' });
    m.signature = signPack(m, priv);
    expect(() =>
      assertPackTrust({
        manifest: m,
        trustedKeys: { acme: pub },
        requireSignature: true,
      }),
    ).not.toThrow();
  });

  it('rejects an unknown publisher', () => {
    const { priv } = keypair();
    const m = manifest({ publisher: 'stranger' });
    m.signature = signPack(m, priv);
    expect(() =>
      assertPackTrust({ manifest: m, trustedKeys: {}, requireSignature: false }),
    ).toThrow(/untrusted\/unknown publisher/);
  });

  it('rejects a tampered signature from a trusted publisher', () => {
    const { pub, priv } = keypair();
    const m = manifest({ publisher: 'acme' });
    m.signature = signPack(m, priv);
    m.description = 'tampered';
    expect(() =>
      assertPackTrust({
        manifest: m,
        trustedKeys: { acme: pub },
        requireSignature: false,
      }),
    ).toThrow(/failed verification/);
  });
});
