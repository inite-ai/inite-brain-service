/**
 * Self-serve issuance rules: a key is never wider than the credential
 * that minted it, and a user-bound caller only ever sees its own.
 *
 * This is the escalation surface of the feature — if any of these give,
 * "issue yourself a key" becomes "issue yourself authority".
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { KeysService } from '../src/keys/keys.service';
import type { ApiKeyRecord } from '../src/auth/api-key.types';
import type { ApiKeySummary } from '../src/auth/api-key-store.service';
import { MAX_ACTIVE_KEYS_PER_TENANT } from '../src/auth/api-key-store.service';

interface StubStoreState {
  issued: Array<
    Parameters<import('../src/auth/api-key-store.service').ApiKeyStoreService['issue']>[0]
  >;
  keys: ApiKeySummary[];
  active: number;
  revoked: Array<{ companyId: string; id: string }>;
}

function makeService(state: Partial<StubStoreState> = {}) {
  const store: StubStoreState = {
    issued: [],
    keys: [],
    active: 0,
    revoked: [],
    ...state,
  };
  const stub = {
    enabled: () => true,
    issue: async (input: unknown) => {
      store.issued.push(input as never);
      return { key: 'brain_stub', summary: { id: 'k1', name: '', prefix: '', scopes: [] } };
    },
    list: async () => store.keys,
    activeCount: async () => store.active,
    revoke: async (companyId: string, id: string) => {
      store.revoked.push({ companyId, id });
      return true;
    },
  };
  return { service: new KeysService(stub as never), store };
}

const caller = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyHash: 'sha256:' + 'a'.repeat(64),
  companyId: 'co_x',
  scopes: ['brain:read', 'brain:write'],
  ...over,
});

describe('KeysService — scope narrowing', () => {
  it('grants only the intersection of requested and held scopes', async () => {
    const { service, store } = makeService();
    await service.issue(caller(), {
      name: 'laptop',
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
    });
    expect(store.issued[0]!.scopes).toEqual(['brain:read', 'brain:write']);
  });

  it('refuses when the caller holds none of what it asked for', async () => {
    const { service } = makeService();
    await expect(
      service.issue(caller({ scopes: ['brain:read'] }), { name: 'x', scopes: ['brain:admin'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never offers the operator-only scopes, even to a credential holding them', () => {
    const { service } = makeService();
    const operator = caller({
      scopes: ['brain:read', 'brain:platform_admin', 'brain:read_media', 'registry:publish'],
    });
    expect(service.issuableScopes(operator)).toEqual(['brain:read']);
  });

  it('caps the number of live keys per tenant', async () => {
    const { service } = makeService({ active: MAX_ACTIVE_KEYS_PER_TENANT });
    await expect(
      service.issue(caller(), { name: 'one too many', scopes: ['brain:read'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('translates a lifetime in days into an expiry', async () => {
    const { service, store } = makeService();
    await service.issue(caller(), { name: 'ci', scopes: ['brain:read'], expiresInDays: 30 });
    const expiresAt = store.issued[0]!.expiresAt!;
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('KeysService — user binding', () => {
  it('binds a user-bound caller to itself', async () => {
    const { service, store } = makeService();
    await service.issue(caller({ userId: 'user_7' }), { name: 'mine', scopes: ['brain:read'] });
    expect(store.issued[0]!.userId).toBe('user_7');
  });

  it('refuses a user-bound caller minting a key for someone else', async () => {
    const { service } = makeService();
    await expect(
      service.issue(caller({ userId: 'user_7' }), {
        name: 'theirs',
        scopes: ['brain:read'],
        userId: 'user_8',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a tenant operator bind a key to any user', async () => {
    const { service, store } = makeService();
    await service.issue(caller({ userId: 'admin_1', scopes: ['brain:read', 'brain:admin'] }), {
      name: 'for someone',
      scopes: ['brain:read'],
      userId: 'user_9',
    });
    expect(store.issued[0]!.userId).toBe('user_9');
  });
});

describe('KeysService — visibility', () => {
  const keys: ApiKeySummary[] = [
    { id: 'k_mine', name: 'mine', prefix: 'brain_1', scopes: [], userId: 'user_7' },
    { id: 'k_theirs', name: 'theirs', prefix: 'brain_2', scopes: [], userId: 'user_8' },
    { id: 'k_tenant', name: 'tenant', prefix: 'brain_3', scopes: [] },
  ];

  it('shows a user-bound caller only its own keys', async () => {
    const { service } = makeService({ keys });
    const visible = await service.list(caller({ userId: 'user_7' }));
    expect(visible.map((k) => k.id)).toEqual(['k_mine']);
  });

  it('shows a tenant operator everything in the tenant', async () => {
    const { service } = makeService({ keys });
    const admin = caller({ userId: 'admin_1', scopes: ['brain:read', 'brain:admin'] });
    expect((await service.list(admin)).map((k) => k.id)).toEqual([
      'k_mine',
      'k_theirs',
      'k_tenant',
    ]);
  });

  it('treats a credential with no user as acting for the tenant', async () => {
    const { service } = makeService({ keys });
    expect((await service.list(caller())).map((k) => k.id)).toHaveLength(3);
  });

  it('will not revoke a key the caller cannot see', async () => {
    const { service, store } = makeService({ keys });
    expect(await service.revoke(caller({ userId: 'user_7' }), 'k_theirs')).toBe(false);
    expect(store.revoked).toHaveLength(0);
    expect(await service.revoke(caller({ userId: 'user_7' }), 'k_mine')).toBe(true);
  });
});
