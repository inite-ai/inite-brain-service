import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { canonicalJson } from './checksum';
import { DomainPackError } from './validate';
import type { DomainPackManifest } from './manifest';

/**
 * Publisher authenticity for distributed packs (docs/domain-packs.md). Checksum
 * proves integrity (unchanged); a signature proves AUTHORSHIP. An ed25519
 * signature is computed over the canonical manifest EXCLUDING its own
 * `signature` field (so signing is not circular). Verification is against a
 * configured trust store (publisher → public key), so a tenant only installs
 * packs from publishers it trusts. Uses node:crypto — no dependency.
 */

/** Canonical bytes signed/verified: the manifest without its signature field. */
function signedBytes(manifest: DomainPackManifest): Buffer {
  const { signature: _sig, ...rest } = manifest;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export function signPack(manifest: DomainPackManifest, privateKeyPem: string): string {
  return cryptoSign(null, signedBytes(manifest), createPrivateKey(privateKeyPem)).toString(
    'base64',
  );
}

export function verifyPackSignature(manifest: DomainPackManifest, publicKeyPem: string): boolean {
  if (!manifest.signature) return false;
  try {
    return cryptoVerify(
      null,
      signedBytes(manifest),
      createPublicKey(publicKeyPem),
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Enforce the install-time trust policy. Throws DomainPackError when a signed
 * pack fails to verify or names an unknown publisher, or when a signature is
 * REQUIRED but absent. An unsigned pack is allowed only when signatures aren't
 * required (integrity-only mode). Pure — the install service supplies the trust
 * store + policy from config, so this is unit-testable without env/DB.
 */
export function assertPackTrust(opts: {
  manifest: DomainPackManifest;
  trustedKeys: Record<string, string>;
  requireSignature: boolean;
}): void {
  const { manifest, trustedKeys, requireSignature } = opts;
  if (!manifest.signature) {
    if (requireSignature) {
      throw new DomainPackError(
        `pack "${manifest.id}" is unsigned but this tenant requires signed packs`,
      );
    }
    return;
  }
  const publisher = manifest.publisher;
  const key = publisher ? trustedKeys[publisher] : undefined;
  if (!key) {
    throw new DomainPackError(
      `pack "${manifest.id}" is signed by an untrusted/unknown publisher "${publisher ?? ''}"`,
    );
  }
  if (!verifyPackSignature(manifest, key)) {
    throw new DomainPackError(
      `pack "${manifest.id}" signature failed verification for publisher "${publisher}"`,
    );
  }
}
