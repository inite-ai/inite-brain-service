/**
 * Unit coverage for validateEnv — focuses on the production fail-closed
 * assertion for the scoped DB pool (SURREALDB_SCOPED_USER/PASS). Without
 * those, withScopedCompany() silently falls back to the root pool and the
 * DB-level PII fence is bypassed; production must refuse to start.
 */
import { validateEnv } from '../src/common/env-validation';

function baseProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SURREALDB_URL: 'ws://db:8000',
    SURREALDB_USERNAME: 'root',
    SURREALDB_PASSWORD: 'root',
    OPENAI_API_KEY: 'sk-test',
    FORGET_HMAC_KEY: 'a'.repeat(40),
    BRAIN_API_KEYS: JSON.stringify([
      { keyHash: 'h', companyId: 'co_a', scopes: ['brain:read'] },
    ]),
    SURREALDB_SCOPED_USER: 'brain_caller',
    SURREALDB_SCOPED_PASS: 'scoped-secret',
  };
}

describe('validateEnv — scoped pool fence', () => {
  it('passes in production when both scoped creds are set', () => {
    expect(() => validateEnv(baseProdEnv())).not.toThrow();
  });

  it('throws in production when scoped creds are missing', () => {
    const env = baseProdEnv();
    delete env.SURREALDB_SCOPED_USER;
    delete env.SURREALDB_SCOPED_PASS;
    expect(() => validateEnv(env)).toThrow(/SURREALDB_SCOPED_USER/);
  });

  it('throws in production when only one scoped cred is set', () => {
    const env = baseProdEnv();
    delete env.SURREALDB_SCOPED_PASS;
    expect(() => validateEnv(env)).toThrow(/SURREALDB_SCOPED/);
  });

  it('does not throw in development when scoped creds are missing', () => {
    const env = baseProdEnv();
    env.NODE_ENV = 'development';
    delete env.SURREALDB_SCOPED_USER;
    delete env.SURREALDB_SCOPED_PASS;
    delete env.FORGET_HMAC_KEY; // dev default allowed
    expect(() => validateEnv(env)).not.toThrow();
  });
});

describe('validateEnv — THROTTLE_DISABLED is test-only', () => {
  it('hard-errors when THROTTLE_DISABLED=1 in production', () => {
    const env = baseProdEnv();
    env.THROTTLE_DISABLED = '1';
    expect(() => validateEnv(env)).toThrow(/THROTTLE_DISABLED/);
  });

  it('allows THROTTLE_DISABLED=1 in development', () => {
    const env = baseProdEnv();
    env.NODE_ENV = 'development';
    env.THROTTLE_DISABLED = '1';
    delete env.FORGET_HMAC_KEY;
    expect(() => validateEnv(env)).not.toThrow();
  });
});

describe('validateEnv — pack supply-chain knobs', () => {
  it('accepts 1/0/true/false for the require-signature flags', () => {
    for (const v of ['1', '0', 'true', 'false']) {
      const env = baseProdEnv();
      env.DOMAIN_PACK_REQUIRE_SIGNATURE = v;
      env.PACK_REGISTRY_REQUIRE_SIGNATURE = v;
      expect(() => validateEnv(env)).not.toThrow();
    }
  });

  it('rejects unrecognized require-signature values (silent fail-open)', () => {
    const env = baseProdEnv();
    // 'yes' would parse as FALSE under a 1/true check — enforcement
    // silently off. That must be a boot error, not a policy downgrade.
    env.DOMAIN_PACK_REQUIRE_SIGNATURE = 'yes';
    expect(() => validateEnv(env)).toThrow(/DOMAIN_PACK_REQUIRE_SIGNATURE/);

    const env2 = baseProdEnv();
    env2.PACK_REGISTRY_REQUIRE_SIGNATURE = 'enabled';
    expect(() => validateEnv(env2)).toThrow(/PACK_REGISTRY_REQUIRE_SIGNATURE/);
  });

  it('rejects malformed DOMAIN_PACK_TRUSTED_KEYS JSON', () => {
    const env = baseProdEnv();
    env.DOMAIN_PACK_TRUSTED_KEYS = '{"acme": '; // truncated
    expect(() => validateEnv(env)).toThrow(/DOMAIN_PACK_TRUSTED_KEYS/);
  });

  it('rejects a trust store that is not publisher→string', () => {
    const env = baseProdEnv();
    env.DOMAIN_PACK_TRUSTED_KEYS = JSON.stringify({ acme: 42 });
    expect(() => validateEnv(env)).toThrow(/DOMAIN_PACK_TRUSTED_KEYS/);
  });

  it('accepts a valid trust store', () => {
    const env = baseProdEnv();
    env.DOMAIN_PACK_TRUSTED_KEYS = JSON.stringify({
      acme: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    });
    expect(() => validateEnv(env)).not.toThrow();
  });
});

describe('validateEnv — registry mirroring (pull-only)', () => {
  it('accepts a valid http(s) REGISTRY_UPSTREAM_URL and a positive interval', () => {
    for (const url of ['https://brain.example.com', 'http://10.0.0.2:3000/']) {
      const env = baseProdEnv();
      env.REGISTRY_UPSTREAM_URL = url;
      env.REGISTRY_MIRROR_INTERVAL_HOURS = '6';
      expect(() => validateEnv(env)).not.toThrow();
    }
  });

  it('accepts the feature-off default (unset / blank URL)', () => {
    const env = baseProdEnv();
    expect(() => validateEnv(env)).not.toThrow();
    env.REGISTRY_UPSTREAM_URL = '  ';
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('rejects a non-URL and a non-http(s) scheme', () => {
    for (const bad of ['not a url', 'ftp://brain.example.com', 'brain.example.com']) {
      const env = baseProdEnv();
      env.REGISTRY_UPSTREAM_URL = bad;
      expect(() => validateEnv(env)).toThrow(/REGISTRY_UPSTREAM_URL/);
    }
  });

  it('rejects a non-positive-integer interval', () => {
    for (const bad of ['0', '-1', 'daily', '1.5']) {
      const env = baseProdEnv();
      env.REGISTRY_MIRROR_INTERVAL_HOURS = bad;
      expect(() => validateEnv(env)).toThrow(/REGISTRY_MIRROR_INTERVAL_HOURS/);
    }
  });
});

describe('validateEnv — ABAC boolean flags', () => {
  it('accepts 1/0/true/false for ABAC_DB_FENCE_ENABLED', () => {
    for (const v of ['1', '0', 'true', 'false']) {
      const env = baseProdEnv();
      env.ABAC_DB_FENCE_ENABLED = v;
      expect(() => validateEnv(env)).not.toThrow();
    }
  });

  it('rejects an unrecognized ABAC_DB_FENCE_ENABLED value (silent fail-open)', () => {
    const env = baseProdEnv();
    // 'yes' parses as OFF under an envFlagEnabled check — the fence would
    // be silently disabled. Boot error, not a silent downgrade.
    env.ABAC_DB_FENCE_ENABLED = 'yes';
    expect(() => validateEnv(env)).toThrow(/ABAC_DB_FENCE_ENABLED/);
  });
});
