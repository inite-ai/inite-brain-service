import { leaseName, tenantLeaseName } from '../src/common/lease-name';
import { tenantLeaseKey } from '../src/common/distributed-lease.guard';
import { deriveLeaseName } from '../src/admin/derive-staging';
import { migrationLeaseName } from '../src/db/migration-lock';

const SAFE = /^[a-z0-9_]+$/;
const HASHED = /_[0-9a-f]{8}$/;

describe('leaseName — the one sanitiser for data-derived lease names', () => {
  it('returns a plain lowercase [a-z0-9_] name unchanged', () => {
    for (const n of ['worker_loop', 'dreams_tenant_acme', 'extract_documents_co_42']) {
      expect(leaseName(n)).toBe(n);
    }
  });

  it.each([
    ['dash', 'dreams_tenant_acme-corp'],
    ['dot', 'dreams_tenant_acme.corp'],
    ['upper case', 'dreams_tenant_AcmeCorp'],
    ['colon', 'dreams_tenant_acme:corp'],
    ['slash and space', 'dreams_tenant_a/b c'],
    ['non-ascii', 'dreams_tenant_β'],
  ])('folds a companyId with a %s and appends a digest', (_label, raw) => {
    const name = leaseName(raw);
    expect(name).toMatch(SAFE);
    expect(name).toMatch(HASHED);
    expect(name.startsWith('dreams_tenant_')).toBe(true);
    expect(leaseName(raw)).toBe(name); // stable
  });

  it('never lets two tenants that fold alike share one lease', () => {
    const ids = ['acme-corp', 'acme.corp', 'acme:corp', 'ACME_CORP', 'Acme-Corp', 'acme_corp'];
    const names = ids.map((id) => tenantLeaseName('dreams_tenant_', id));
    expect(new Set(names).size).toBe(ids.length);
    for (const n of names) expect(n).toMatch(SAFE);
  });

  it('never returns a plain name that equals the hashed form of another input', () => {
    const hashed = leaseName('t_a-b');
    // The plain twin of a hashed name is itself hashed, so it moves away.
    expect(leaseName(hashed)).not.toBe(hashed);
    expect(leaseName(hashed)).toMatch(SAFE);
  });

  it('caps a long name and keeps it distinct by digest', () => {
    const a = leaseName(`p_${'x'.repeat(100)}a`);
    const b = leaseName(`p_${'x'.repeat(100)}b`);
    expect(a.length).toBeLessThanOrEqual(48 + 9);
    expect(a).not.toBe(b);
  });
});

describe('lease-name call sites share the sanitiser', () => {
  it('tenantLeaseKey keeps a plain companyId readable and hashes the rest', () => {
    expect(tenantLeaseKey('hnsw_provision_startup_', 'acme')).toBe('hnsw_provision_startup_acme');
    expect(tenantLeaseKey('hnsw_provision_startup_', 'Acme-1')).toMatch(SAFE);
    expect(tenantLeaseKey('hnsw_provision_startup_', 'acme-1')).not.toBe(
      tenantLeaseKey('hnsw_provision_startup_', 'acme_1'),
    );
  });

  it('migrationLeaseName is byte-identical to its pre-sanitiser form', () => {
    // Pinned so a rolling deploy keeps old and new replicas on one row.
    expect(migrationLeaseName('brain', 'co_acme')).toBe('migrate_brain_co_acme_8ed4a28e');
  });

  it('deriveLeaseName keeps (tenant, version) pairs apart across the separator', () => {
    expect(deriveLeaseName('co_a', 'b')).not.toBe(deriveLeaseName('co', 'a_b'));
    expect(deriveLeaseName('Co.X:1', 'wd-v3')).toMatch(/^derive_[a-z0-9_]+_[0-9a-f]{8}$/);
  });
});
