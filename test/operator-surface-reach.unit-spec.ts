/**
 * Operator surfaces that are the platform operator's, not a tenant's:
 *
 *  - GET /v1/admin/mri and /v1/admin/mri/operating-point are built from the
 *    process-wide metrics registry (every tenant's traffic on the replica):
 *    a tenant brain:admin gets 404, like an absent route; the platform
 *    operator (brain:platform_admin + BRAIN_TENANT_OVERRIDE_ENABLED) gets
 *    the report.
 *  - DELETE /v1/admin/tenants/:companyId drops an eval_* tenant: the
 *    caller's own, or any for the platform operator. Before, any tenant's
 *    brain:admin could drop any eval tenant by naming it.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MriAdminController } from '../src/mri/mri-admin.controller';
import type { MriService } from '../src/mri/mri.service';
import { PLATFORM_SCOPES, adminReq, makeAdminController } from './helpers/admin-controllers';

const savedGate = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
afterEach(() => {
  if (savedGate === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = savedGate;
});

describe('MRI is the platform operator’s', () => {
  const report = { operatingPoint: { sampleCount: 1 } };
  const mri = new MriAdminController({ generate: async () => report } as unknown as MriService);

  it('a tenant brain:admin gets 404 on both routes', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    await expect(mri.report(adminReq())).rejects.toBeInstanceOf(NotFoundException);
    await expect(mri.operatingPoint(adminReq())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the platform scope without the gate is not enough', async () => {
    delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
    await expect(mri.report(adminReq(PLATFORM_SCOPES))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the platform operator gets the report', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    await expect(mri.report(adminReq(PLATFORM_SCOPES))).resolves.toBe(report);
    await expect(mri.operatingPoint(adminReq(PLATFORM_SCOPES))).resolves.toEqual({
      sampleCount: 1,
    });
  });
});

describe('dropping an eval tenant', () => {
  function controller(dropped: string[]) {
    return makeAdminController({
      admin: {
        dropTenantDatabase: async (c: string) => {
          dropped.push(c);
        },
      },
    });
  }

  it("a tenant admin cannot drop another tenant's eval database", async () => {
    const dropped: string[] = [];
    await expect(
      controller(dropped).dropTenant(adminReq(undefined, 'tenant-a'), 'eval_someone_else'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(dropped).toEqual([]);
  });

  it('an eval tenant may drop itself', async () => {
    const dropped: string[] = [];
    await controller(dropped).dropTenant(adminReq(undefined, 'eval_self'), 'eval_self');
    expect(dropped).toEqual(['eval_self']);
  });

  it('the platform operator may drop any eval tenant, and still no real one', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const dropped: string[] = [];
    await controller(dropped).dropTenant(adminReq(PLATFORM_SCOPES), 'eval_any');
    await expect(
      controller(dropped).dropTenant(adminReq(PLATFORM_SCOPES), 'co_real'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(dropped).toEqual(['eval_any']);
  });
});
