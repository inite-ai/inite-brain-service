import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Credentials at rest (raw-evidence-sources-2026-09.md W4). A source
 * connection's `credential` and an OAuth grant's token set are strings
 * in the tenant DB; with SOURCE_CREDENTIAL_ENCRYPTION_KEY set they are stored as
 * AES-256-GCM ciphertext —
 *
 *   enc:v1:<kid>:<iv>:<tag>:<ciphertext>      (base64url parts)
 *
 * — and decrypted only on the engine's read. `kid` is the first 8 hex of
 * SHA-256(key), so a rotation (SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS carrying
 * the old key) decrypts what each key wrote and every write uses the
 * current one. A value without the prefix is plaintext from before the
 * key existed and is returned as-is; it is re-encrypted the next time
 * the row's credential is written.
 *
 * Pure module: no Nest, no I/O; the keys are read from env per call so
 * a rotation needs no restart. OAuth grants REQUIRE the key — a refresh
 * token is never written in the clear (the client refuses to start).
 */

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialCipherError extends Error {}

/** The keys in force: [current, previous?]; empty = encryption off. */
export function credentialKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const out: Buffer[] = [];
  for (const name of [
    'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
    'SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS',
  ]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    out.push(decodeKey(raw, name));
  }
  return out;
}

export function credentialCipherReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SOURCE_CREDENTIAL_ENCRYPTION_KEY?.trim());
}

/** Ciphertext under the current key; the plaintext itself when no key is set. */
export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const [key] = credentialKeys(env);
  if (!key) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${kidOf(key)}:${b64(iv)}:${b64(tag)}:${b64(ct)}`;
}

/** The plaintext of a stored value — ciphertext by whichever key wrote it, or a legacy clear value. */
export function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 4) throw new CredentialCipherError('malformed encrypted credential');
  const [kid, ivB, tagB, ctB] = parts as [string, string, string, string];
  const key = credentialKeys(env).find((k) => kidOf(k) === kid);
  if (!key) {
    throw new CredentialCipherError(
      `no SOURCE_CREDENTIAL_ENCRYPTION_KEY matches the key (${kid}) this credential was encrypted with`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(ivB));
  decipher.setAuthTag(unb64(tagB));
  try {
    return Buffer.concat([decipher.update(unb64(ctB)), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialCipherError('encrypted credential failed authentication');
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

function decodeKey(raw: string, name: string): Buffer {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.byteLength !== KEY_BYTES) {
    throw new CredentialCipherError(
      `${name} must be 32 bytes (base64 or 64 hex chars), got ${buf.byteLength}`,
    );
  }
  return buf;
}

function kidOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
