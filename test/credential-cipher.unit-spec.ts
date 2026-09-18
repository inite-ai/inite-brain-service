/**
 * Credentials at rest (W4): AES-256-GCM under SOURCE_CREDENTIAL_ENCRYPTION_KEY —
 *  - no key ⇒ the value is stored as-is (the pre-W4 posture);
 *  - with a key ⇒ `enc:v1:<kid>:…`, round-trips, and never repeats (fresh IV);
 *  - a legacy clear value decrypts to itself;
 *  - rotation: the previous key decrypts what it wrote, writes use the current;
 *  - a ciphertext under an unknown key, or tampered, is refused by name;
 *  - a key of the wrong length is refused.
 */
import { randomBytes } from 'node:crypto';
import {
  CredentialCipherError,
  credentialCipherReady,
  decryptSecret,
  encryptSecret,
  isEncrypted,
} from '../src/source-plane/credential-cipher';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('hex');

describe('credential cipher', () => {
  it('stores as-is without a key', () => {
    const env = {};
    expect(credentialCipherReady(env)).toBe(false);
    expect(encryptSecret('hunter2', env)).toBe('hunter2');
    expect(decryptSecret('hunter2', env)).toBe('hunter2');
  });

  it('round-trips under the key with a fresh IV each time', () => {
    const env = { SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyA };
    const a = encryptSecret('hunter2', env);
    const b = encryptSecret('hunter2', env);
    expect(isEncrypted(a)).toBe(true);
    expect(a.startsWith('enc:v1:')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter2');
    expect(decryptSecret(a, env)).toBe('hunter2');
    expect(decryptSecret(b, env)).toBe('hunter2');
    // A legacy clear value stays readable.
    expect(decryptSecret('legacy-token', env)).toBe('legacy-token');
  });

  it('rotates: the previous key decrypts, the current key writes', () => {
    const before = encryptSecret('old-secret', { SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyA });
    const rotated = {
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyB,
      SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: keyA,
    };
    expect(decryptSecret(before, rotated)).toBe('old-secret');
    const after = encryptSecret('new-secret', rotated);
    expect(after.split(':')[2]).not.toBe(before.split(':')[2]);
    expect(decryptSecret(after, { SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyB })).toBe('new-secret');
    // Once the previous key is gone, what it wrote is refused by name.
    expect(() => decryptSecret(before, { SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyB })).toThrow(
      /no SOURCE_CREDENTIAL_ENCRYPTION_KEY matches/,
    );
  });

  it('refuses a tampered ciphertext and a malformed one', () => {
    const env = { SOURCE_CREDENTIAL_ENCRYPTION_KEY: keyA };
    const good = encryptSecret('hunter2', env);
    const parts = good.split(':');
    const ct = parts[5]!;
    parts[5] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptSecret(parts.join(':'), env)).toThrow(CredentialCipherError);
    expect(() => decryptSecret('enc:v1:oops', env)).toThrow(/malformed/);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => encryptSecret('x', { SOURCE_CREDENTIAL_ENCRYPTION_KEY: 'too-short' })).toThrow(
      /must be 32 bytes/,
    );
  });
});
