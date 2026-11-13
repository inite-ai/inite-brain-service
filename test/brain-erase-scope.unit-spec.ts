/**
 * brain:erase — the narrow scope a product backend holds to erase ONE
 * end-user (GDPR forget, affect erase, consent withdrawal) without
 * brain:admin.
 *
 * The guard is driven with the REAL controller metadata (the handlers'
 * decorators read through a real Reflector), so a decorator that drifts
 * on any of these routes fails here, not in production.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import type { ApiKeyRecord, BrainScope } from '../src/auth/api-key.types';
import type { CredentialResolverService } from '../src/auth/credential-resolver.service';
import type { PolicyGateService } from '../src/policy/policy-gate.service';
import type { MembershipService } from '../src/auth/membership.service';
import { runWithRequestContext } from '../src/common/request-context';
import { UserForgetController } from '../src/entities/user-forget.controller';
import type { UserForgetService } from '../src/entities/user-forget.service';
import { EntitiesController } from '../src/entities/entities.controller';
import { AffectController } from '../src/affect/affect.controller';
import { SafetyController } from '../src/affect/safety.controller';
import { IngestController } from '../src/ingest/ingest.controller';
import { FactsController } from '../src/facts/facts.controller';
import { issuableFor, ISSUABLE_SCOPES } from '../src/keys/issuable-scopes';
import { IssuableScopeSchema } from '../src/contracts/keys/keys.schema';

type Handler = (...args: never[]) => unknown;

function guardFor(scopes: BrainScope[]): ApiKeyGuard {
  const record: ApiKeyRecord = { keyHash: 'sha256:test', companyId: 'co_test', scopes };
  const credentials = { resolve: async () => record } as unknown as CredentialResolverService;
  const policyGate = { gate: async () => undefined } as unknown as PolicyGateService;
  const membership = { tagsFor: async () => [] } as unknown as MembershipService;
  return new ApiKeyGuard(credentials, new Reflector(), policyGate, membership);
}

function contextFor(cls: object, handler: Handler): ExecutionContext {
  const req = { headers: { authorization: 'Bearer test' }, method: 'POST', url: '/' };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

async function admits(scopes: BrainScope[], cls: object, handler: Handler): Promise<boolean> {
  try {
    return await guardFor(scopes).canActivate(contextFor(cls, handler));
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

const ERASE: BrainScope[] = ['brain:erase'];

const ERASE_ROUTES: Array<[string, object, Handler]> = [
  [
    'POST /v1/users/:userId/forget',
    UserForgetController,
    UserForgetController.prototype.forget as Handler,
  ],
  [
    'DELETE /v1/users/:userId/affect',
    AffectController,
    AffectController.prototype.eraseAffect as Handler,
  ],
  [
    'DELETE /v1/users/:userId/consents/:purpose',
    AffectController,
    AffectController.prototype.revokeConsent as Handler,
  ],
];

describe('brain:erase — what it opens', () => {
  it.each(ERASE_ROUTES)('%s admits brain:erase alone', async (_name, cls, handler) => {
    await expect(admits(ERASE, cls, handler)).resolves.toBe(true);
  });

  it('user forget still admits brain:admin', async () => {
    await expect(
      admits(['brain:admin'], UserForgetController, UserForgetController.prototype.forget),
    ).resolves.toBe(true);
  });

  it('affect erase and consent withdrawal still admit brain:write', async () => {
    await expect(
      admits(['brain:write'], AffectController, AffectController.prototype.eraseAffect),
    ).resolves.toBe(true);
    await expect(
      admits(['brain:write'], AffectController, AffectController.prototype.revokeConsent),
    ).resolves.toBe(true);
  });

  it('user forget refuses a key with neither scope (brain:read + brain:write)', async () => {
    await expect(
      admits(
        ['brain:read', 'brain:write'],
        UserForgetController,
        UserForgetController.prototype.forget,
      ),
    ).resolves.toBe(false);
  });
});

describe('brain:erase — what it does not open', () => {
  const refused: Array<[string, object, Handler]> = [
    // Reads
    [
      'read: GET /v1/entities/:id',
      EntitiesController,
      EntitiesController.prototype.getProfile as Handler,
    ],
    [
      'read: GET /v1/users/:userId/affect (export)',
      AffectController,
      AffectController.prototype.exportAffect as Handler,
    ],
    [
      'read: GET /v1/users/:userId/consents',
      AffectController,
      AffectController.prototype.listConsents as Handler,
    ],
    ['read: GET /v1/facts/:id', FactsController, FactsController.prototype.get as Handler],
    // Writes
    [
      'write: POST /v1/ingest/fact',
      IngestController,
      IngestController.prototype.ingestFact as Handler,
    ],
    [
      'write: POST /v1/users/:userId/consents',
      AffectController,
      AffectController.prototype.recordConsent as Handler,
    ],
    [
      'write: POST /v1/users/:userId/affect/:id/contest',
      AffectController,
      AffectController.prototype.contest as Handler,
    ],
    // Admin
    [
      'admin: POST /v1/entities/:id/forget',
      EntitiesController,
      EntitiesController.prototype.forget as Handler,
    ],
    [
      'admin: GET /v1/admin/safety/report',
      SafetyController,
      SafetyController.prototype.report as Handler,
    ],
  ];

  it.each(refused)('%s refuses brain:erase alone (403)', async (_name, cls, handler) => {
    expect(typeof handler).toBe('function');
    await expect(admits(ERASE, cls, handler)).resolves.toBe(false);
  });
});

describe('brain:erase — the pin on a user-bound token', () => {
  const forgetUser = jest.fn(async (_companyId: string, userId: string) => ({ userId }));
  const controller = new UserForgetController({
    forgetUser,
  } as unknown as UserForgetService);
  const req = { brainAuth: { companyId: 'co_test', scopes: ERASE, keyHash: 'k' } } as never;

  beforeEach(() => forgetUser.mockClear());

  it('a user-bound token erases its own user', async () => {
    await runWithRequestContext({ authUserId: 'alice' } as never, () =>
      controller.forget(req, 'alice'),
    );
    expect(forgetUser).toHaveBeenCalledWith('co_test', 'alice');
  });

  it('a user-bound token naming another user is 403 and erases nothing', async () => {
    await expect(
      runWithRequestContext({ authUserId: 'alice' } as never, () => controller.forget(req, 'bob')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(forgetUser).not.toHaveBeenCalled();
  });

  it('an M2M key (no end-user) erases the named user', async () => {
    await runWithRequestContext({} as never, () => controller.forget(req, 'bob'));
    expect(forgetUser).toHaveBeenCalledWith('co_test', 'bob');
  });
});

describe('brain:erase — no other route names it', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('only the three erase routes mention brain:erase in a scope decorator', () => {
    const root = join(__dirname, '..');
    const hits: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/@Require(?:Any)?Scopes?\(([^)]*)\)/g)) {
        if (m[1]!.includes('brain:erase')) hits.push(`${relative(root, file)}: ${m[0]}`);
      }
    }
    expect(hits.sort()).toEqual([
      "src/affect/affect.controller.ts: @RequireAnyScope('brain:write', 'brain:erase')",
      "src/affect/affect.controller.ts: @RequireAnyScope('brain:write', 'brain:erase')",
      "src/entities/user-forget.controller.ts: @RequireAnyScope('brain:admin', 'brain:erase')",
    ]);
  });

  it('no code path tests for brain:erase outside the scope catalogue', () => {
    // A `scopes.includes('brain:erase')` somewhere would be a grant the
    // decorators do not show.
    const root = join(__dirname, '..');
    const hits = walk(join(root, 'src')).filter((file) =>
      /includes\(\s*'brain:erase'\s*\)/.test(readFileSync(file, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});

describe('brain:erase — registered where scopes are enumerated', () => {
  const root = join(__dirname, '..');
  const setBlock = (file: string, name: string): string =>
    new RegExp(`const ${name}[\\s\\S]*?\\]\\);`).exec(
      readFileSync(join(root, file), 'utf8'),
    )?.[0] ?? '';

  it('JWT VALID_SCOPES and introspected scopes accept it', () => {
    expect(setBlock('src/auth/jwks.service.ts', 'VALID_SCOPES')).toContain("'brain:erase'");
    expect(setBlock('src/auth/introspection.client.ts', 'INTROSPECTED_SCOPES')).toContain(
      "'brain:erase'",
    );
  });

  it('is issuable, and a brain:admin caller may grant it without holding it', () => {
    expect(ISSUABLE_SCOPES).toContain('brain:erase');
    expect(IssuableScopeSchema.options).toContain('brain:erase');
    expect(issuableFor(['brain:admin'])).toEqual(['brain:admin', 'brain:erase']);
    expect(issuableFor(['brain:erase'])).toEqual(['brain:erase']);
    // brain:erase grants nothing wider than itself.
    expect(issuableFor(['brain:read', 'brain:write'])).toEqual(['brain:read', 'brain:write']);
  });
});
