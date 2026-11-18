import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * scripts/ci/audit.mjs is the `supply-chain` verdict: high and critical
 * advisories fail unless .inite/audit-allow.json allows them with a reason
 * and an expiry. Run as a subprocess, the way CI runs it.
 */

const ROOT = join(__dirname, '..');
const AUDIT = join(ROOT, 'scripts', 'ci', 'audit.mjs');
const entry = {
  advisory: 'GHSA-xxxx-yyyy-zzzz',
  package: 'pkg',
  reason: 'no patched release; dev tooling only',
  expires: '2026-12-17',
};

function run(json: unknown, today: string, allow: unknown[] = [entry]) {
  const r = spawnSync(process.execPath, [AUDIT], {
    input: typeof json === 'string' ? json : JSON.stringify(json),
    env: { ...process.env, AUDIT_TODAY: today, AUDIT_ALLOW_JSON: JSON.stringify(allow) },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const adv = (id: string, severity: string) => ({
  advisories: {
    '1': {
      github_advisory_id: id,
      module_name: 'pkg',
      severity,
      title: 't',
      patched_versions: '<0.0.0',
    },
  },
});

describe('supply-chain audit verdict', () => {
  const before = new Date(Date.parse(entry.expires) - 86400000).toISOString().slice(0, 10);
  const after = new Date(Date.parse(entry.expires) + 86400000).toISOString().slice(0, 10);

  it('passes a clean tree and a moderate advisory', () => {
    expect(run({ advisories: {} }, before).code).toBe(0);
    expect(run(adv('GHSA-aaaa-bbbb-cccc', 'moderate'), before).code).toBe(0);
  });

  it('fails a high or critical advisory nobody allowed', () => {
    expect(run(adv('GHSA-aaaa-bbbb-cccc', 'high'), before).code).toBe(1);
    expect(run(adv('GHSA-aaaa-bbbb-cccc', 'critical'), before).code).toBe(1);
  });

  it('passes an allowed advisory until its date, and fails it after', () => {
    expect(run(adv(entry.advisory, 'high'), before).code).toBe(0);
    const late = run(adv(entry.advisory, 'high'), after);
    expect(late.code).toBe(1);
    expect(late.out).toContain('expired');
  });

  it('fails an allowance without a reason or past 90 days', () => {
    expect(run(adv(entry.advisory, 'high'), before, [{ ...entry, reason: '' }]).code).toBe(1);
    expect(run({ advisories: {} }, '2026-09-01').code).toBe(1);
  });

  it('fails when the audit gave no JSON or an error', () => {
    expect(run('', before).code).toBe(1);
    expect(run({ error: { code: 'ERR', message: 'network' } }, before).code).toBe(1);
  });
});
