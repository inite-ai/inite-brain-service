import {
  applyStoredSettings,
  decodeStoredRows,
  deployValueOf,
  hasDeployValue,
  restoreDeployValue,
  SETTINGS_ENV_ONLY,
  type StoredSetting,
} from '../src/common/platform-settings';
import { encryptSecret } from '../src/common/secret-cipher';

/**
 * The store is only worth having if a stored value REPLACES what the
 * deploy shipped and can be taken back off again — and if the two keys
 * that would let it lock itself out (the database it lives in, the key
 * its secrets are encrypted under) can never be moved into it.
 */
describe('platform settings applied over the environment', () => {
  const row = (key: string, value: string, secret = false): StoredSetting => ({
    key,
    value,
    secret,
  });

  it('overrides a deploy value, remembers what it replaced, and puts it back', () => {
    const env: NodeJS.ProcessEnv = { RETRIEVAL_VERIFIER_MODEL: 'gpt-5.6-luna' };
    applyStoredSettings(env, [row('RETRIEVAL_VERIFIER_MODEL', 'gpt-6-luna')]);
    expect(env.RETRIEVAL_VERIFIER_MODEL).toBe('gpt-6-luna');
    expect(hasDeployValue('RETRIEVAL_VERIFIER_MODEL')).toBe(true);
    expect(deployValueOf('RETRIEVAL_VERIFIER_MODEL')).toBe('gpt-5.6-luna');

    restoreDeployValue('RETRIEVAL_VERIFIER_MODEL', env);
    expect(env.RETRIEVAL_VERIFIER_MODEL).toBe('gpt-5.6-luna');
  });

  it('a key the deploy never set is deleted again, not blanked', () => {
    const env: NodeJS.ProcessEnv = {};
    applyStoredSettings(env, [row('SOURCE_KIND_NOTION', '1')]);
    expect(env.SOURCE_KIND_NOTION).toBe('1');
    restoreDeployValue('SOURCE_KIND_NOTION', env);
    expect('SOURCE_KIND_NOTION' in env).toBe(false);
  });

  it('refuses the keys that would lock the store out of its own database', () => {
    const env: NodeJS.ProcessEnv = { SURREALDB_URL: 'ws://real:8000' };
    const lines = applyStoredSettings(env, [
      row('SURREALDB_URL', 'ws://attacker:8000'),
      row('SOURCE_CREDENTIAL_ENCRYPTION_KEY', 'aaaa'),
    ]);
    expect(env.SURREALDB_URL).toBe('ws://real:8000');
    expect(env.SOURCE_CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(lines.every((l) => l.includes('environment-only'))).toBe(true);
    for (const key of ['SURREALDB_URL', 'SOURCE_CREDENTIAL_ENCRYPTION_KEY', 'PROCESS_ROLE']) {
      expect(SETTINGS_ENV_ONLY.has(key)).toBe(true);
    }
  });

  it('refuses a stored row whose key is not an environment variable name', () => {
    const env: NodeJS.ProcessEnv = {};
    const lines = applyStoredSettings(env, [
      row('__proto__', '{"polluted":true}'),
      row('constructor', 'x'),
      row('lower_case', 'x'),
      row('WITH.DOT', 'x'),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.includes('not an environment variable name'))).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(env).toEqual({});
  });

  it('never logs a secret value', () => {
    const env: NodeJS.ProcessEnv = {};
    const lines = applyStoredSettings(env, [
      row('SOURCE_OAUTH_GOOGLE_CLIENT_SECRET', 'hunter2', true),
    ]);
    expect(env.SOURCE_OAUTH_GOOGLE_CLIENT_SECRET).toBe('hunter2');
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).toContain('(secret)');
  });
});

describe('rows as the driver hands them back', () => {
  const key = { SOURCE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

  it('opens a stored secret and carries the bookkeeping', () => {
    const stored = encryptSecret('s3cr3t', key);
    const [decoded] = decodeStoredRows(
      [
        {
          key: 'SOURCE_OAUTH_SLACK_CLIENT_SECRET',
          value: stored,
          secret: true,
          updatedAt: new Date('2026-09-24T10:00:00Z'),
          updatedBy: 'ops@inite',
          note: 'the new app',
        },
      ],
      key,
    );
    expect(decoded).toMatchObject({
      key: 'SOURCE_OAUTH_SLACK_CLIENT_SECRET',
      value: 's3cr3t',
      secret: true,
      updatedBy: 'ops@inite',
      note: 'the new app',
    });
    expect(decoded?.updatedAt).toBe('2026-09-24T10:00:00.000Z');
  });

  it('drops a row it cannot open rather than applying ciphertext as a value', () => {
    const stored = encryptSecret('s3cr3t', key);
    const other = { SOURCE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
    expect(decodeStoredRows([{ key: 'K', value: stored, secret: true }], other)).toEqual([]);
  });

  it('leaves a value that was never encrypted alone', () => {
    const [decoded] = decodeStoredRows([{ key: 'K', value: 'plain', secret: false }], key);
    expect(decoded?.value).toBe('plain');
  });
});
