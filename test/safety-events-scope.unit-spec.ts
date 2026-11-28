/**
 * GET /v1/users/:userId/safety-events — a crisis referral is
 * special-category (health) data, so reading the record takes
 * brain:read_pii on top of brain:read, the same bar as the affect export.
 * Driven through the real guard with the controller's real decorators.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import type { ApiKeyRecord, BrainScope } from '../src/auth/api-key.types';
import type { CredentialResolverService } from '../src/auth/credential-resolver.service';
import type { PolicyGateService } from '../src/policy/policy-gate.service';
import type { MembershipService } from '../src/auth/membership.service';
import { SafetyController } from '../src/affect/safety.controller';
import { AffectController } from '../src/affect/affect.controller';

type Handler = (...args: never[]) => unknown;

async function admits(scopes: BrainScope[], cls: object, handler: Handler): Promise<boolean> {
  const record: ApiKeyRecord = { keyHash: 'sha256:test', companyId: 'co_test', scopes };
  const guard = new ApiKeyGuard(
    { resolve: async () => record } as unknown as CredentialResolverService,
    new Reflector(),
    { gate: async () => undefined } as unknown as PolicyGateService,
    { tagsFor: async () => [] } as unknown as MembershipService,
  );
  const req = { headers: { authorization: 'Bearer test' }, method: 'GET', url: '/' };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
  try {
    return await guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('safety events read scope', () => {
  const list = SafetyController.prototype.list as Handler;

  it('brain:read alone is refused', async () => {
    await expect(admits(['brain:read'], SafetyController, list)).resolves.toBe(false);
  });

  it('brain:read + brain:read_pii is admitted', async () => {
    await expect(admits(['brain:read', 'brain:read_pii'], SafetyController, list)).resolves.toBe(
      true,
    );
  });

  it('matches the affect export bar', async () => {
    const exportAffect = AffectController.prototype.exportAffect as Handler;
    await expect(admits(['brain:read'], AffectController, exportAffect)).resolves.toBe(false);
    await expect(
      admits(['brain:read', 'brain:read_pii'], AffectController, exportAffect),
    ).resolves.toBe(true);
  });
});
