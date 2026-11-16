import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import {
  childTenantId,
  CHILD_TENANT_HEADER,
  isChildTenantId,
  resolveChildTenant,
} from '../src/auth/child-tenant';
import type { ApiKeyRecord, BrainScope } from '../src/auth/api-key.types';
import type { CredentialResolverService } from '../src/auth/credential-resolver.service';
import type { PolicyGateService } from '../src/policy/policy-gate.service';
import type { MembershipService } from '../src/auth/membership.service';
import { ChildTenantsService } from '../src/tenants/child-tenants.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { TenantRegistryService } from '../src/auth/tenant-registry.service';

/**
 * One product machine client, many client companies, each in a tenant of
 * its own (ADR docs/adr/0001-child-tenants.md). The parent half of a child
 * id is the credential's own tenant, never what the caller asserts.
 */
const rent = (scopes: BrainScope[] = ['brain:read', 'brain:write', 'brain:tenants']) =>
  ({ companyId: 'rent', scopes, keyHash: 'h_rent' }) as ApiKeyRecord;
const training = () =>
  ({
    companyId: 'training',
    scopes: ['brain:read', 'brain:write', 'brain:tenants'],
    keyHash: 'h_training',
  }) as ApiKeyRecord;

describe('child tenant ids', () => {
  it('derive from the parent and stay inside its namespace', () => {
    expect(childTenantId('rent', 'acme-42')).toBe('rent__acme-42');
    expect(isChildTenantId('rent__acme-42')).toBe(true);
    expect(isChildTenantId('rent')).toBe(false);
  });

  it.each(['', 'Acme', 'acme_42', 'training__acme', '-acme', 'a'.repeat(41), '../x'])(
    'refuse %p as a child id',
    (child) => {
      expect(() => childTenantId('rent', child)).toThrow(BadRequestException);
    },
  );

  it('do not nest, and never exceed the companyId length', () => {
    expect(() => childTenantId('rent__acme', 'branch')).toThrow(ForbiddenException);
    expect(() => childTenantId('p'.repeat(40), 'c'.repeat(30))).toThrow(BadRequestException);
  });
});

describe('resolveChildTenant', () => {
  const header = (child: string) => ({ [CHILD_TENANT_HEADER]: child });

  it('no header: the caller stays in its own tenant', () => {
    expect(resolveChildTenant(rent(), {})).toBeUndefined();
  });

  it("product A cannot reach product B's children, whatever it names", () => {
    expect(resolveChildTenant(rent(), header('acme'))).toBe('rent__acme');
    expect(resolveChildTenant(training(), header('acme'))).toBe('training__acme');
    // Naming B's child id outright is not a child id at all.
    expect(() => resolveChildTenant(rent(), header('training__acme'))).toThrow(BadRequestException);
  });

  it('needs brain:tenants', () => {
    expect(() => resolveChildTenant(rent(['brain:read', 'brain:write']), header('acme'))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a user-bound token', () => {
    expect(() => resolveChildTenant({ ...rent(), userId: 'u1' }, header('acme'))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a credential that names a child tenant as its own', () => {
    const forged = { ...training(), companyId: 'rent__acme' };
    expect(() => resolveChildTenant(forged, {})).toThrow(ForbiddenException);
  });
});

describe('ApiKeyGuard with a child header', () => {
  function run(record: ApiKeyRecord, headers: Record<string, string>) {
    const noted: string[] = [];
    const credentials = {
      resolve: async () => record,
      noteTenant: (id: string) => noted.push(id),
    } as unknown as CredentialResolverService;
    const policy = { gate: async () => undefined } as unknown as PolicyGateService;
    const membership = { tagsFor: async () => [] } as unknown as MembershipService;
    const guard = new ApiKeyGuard(credentials, new Reflector(), policy, membership);
    const req: Record<string, unknown> = {
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: 'Bearer t', ...headers },
    };
    function handler() {}
    class Ctl {}
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      getHandler: () => handler,
      getClass: () => Ctl,
    } as unknown as ExecutionContext;
    return {
      go: () => guard.canActivate(context),
      tenant: () => (req.brainAuth as { companyId: string }).companyId,
      noted,
    };
  }

  it('runs the request in the child and puts the child in the roster', async () => {
    const r = run(rent(), { [CHILD_TENANT_HEADER]: 'acme' });
    await expect(r.go()).resolves.toBe(true);
    expect(r.tenant()).toBe('rent__acme');
    expect(r.noted).toEqual(['rent__acme']);
  });

  it('two products naming the same child land in two tenants', async () => {
    const a = run(rent(), { [CHILD_TENANT_HEADER]: 'acme' });
    const b = run(training(), { [CHILD_TENANT_HEADER]: 'acme' });
    await a.go();
    await b.go();
    expect(a.tenant()).not.toBe(b.tenant());
  });

  it('without the header, the parent tenant as before', async () => {
    const r = run(rent(), {});
    await r.go();
    expect(r.tenant()).toBe('rent');
    expect(r.noted).toEqual([]);
  });
});

describe('whole-child erase', () => {
  it('drops only the derived child database and forgets its registry row', async () => {
    const dropped: string[] = [];
    const forgotten: string[] = [];
    const surreal = {
      dropCompanyDatabase: async (id: string) => void dropped.push(id),
    } as unknown as SurrealService;
    const registry = {
      forget: async (id: string) => void forgotten.push(id),
    } as unknown as TenantRegistryService;
    const svc = new ChildTenantsService(surreal, registry);
    expect(await svc.erase('rent', 'acme')).toEqual({ childId: 'rent__acme', erased: true });
    expect(dropped).toEqual(['rent__acme']);
    expect(forgotten).toEqual(['rent__acme']);
    await expect(svc.erase('rent', 'training__acme')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.erase('rent__acme', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    expect(dropped).toEqual(['rent__acme']);
  });
});
