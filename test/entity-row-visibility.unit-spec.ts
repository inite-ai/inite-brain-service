/**
 * The entity ROW (name, type, externalRefs) follows the same user fence
 * as its facts: another user's personal entity is absent (404 / null /
 * no name), and the typeahead carries the scope-tag fence. Before, the
 * profile by id, the profile by external ref and the timeline's name
 * lookup returned another user's personal entity name and refs.
 */
import { NotFoundException } from '@nestjs/common';
import { EntitiesService } from '../src/entities/entities.service';
import { entityRowVisible } from '../src/entities/entity-read.helpers';
import { runWithRequestContext } from '../src/common/request-context';
import type { BrainScope } from '../src/auth/api-key.types';

const scopes: BrainScope[] = ['brain:read'];

function makeEntities(entity: Record<string, unknown>) {
  const sqls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown>) => {
      sqls.push({ sql, params });
      if (sql.includes('FROM entity_external_ref')) {
        return [[{ entity: 'knowledge_entity:e1', userId: entity.userId, scope: entity.scope }]];
      }
      if (sql.includes("FROM type::record('knowledge_entity'")) return [[entity]];
      return [[]];
    },
  };
  const surreal = {
    withScopedCompany: async (_c: string, _s: unknown, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
  } as never;
  return { svc: new EntitiesService(surreal, undefined as never), sqls };
}

const personal = { id: 'knowledge_entity:e1', type: 'person', canonicalName: 'Bob', userId: 'u1' };
const shared = { id: 'knowledge_entity:e1', type: 'person', canonicalName: 'Acme' };

describe('entityRowVisible', () => {
  it('a personal entity is visible only to its owner', () => {
    expect(entityRowVisible({ userId: 'u1' }, 'u1')).toBe(true);
    expect(entityRowVisible({ userId: 'u1' }, 'u2')).toBe(false);
    expect(entityRowVisible({ userId: 'u1' }, undefined)).toBe(false);
    expect(entityRowVisible({}, undefined)).toBe(true);
  });
});

describe('entity reads: personal entity of another user', () => {
  const profile = (svc: EntitiesService, userId?: string) =>
    svc.getProfile({ companyId: 'co_x', entityIdRaw: 'e1', asOfRaw: undefined, userId, scopes });

  it('profile: 404 for a caller naming no user, served to the owner', async () => {
    await expect(profile(makeEntities(personal).svc)).rejects.toBeInstanceOf(NotFoundException);
    await expect(profile(makeEntities(personal).svc, 'u1')).resolves.toMatchObject({
      canonicalName: 'Bob',
    });
    await expect(profile(makeEntities(shared).svc)).resolves.toMatchObject({
      canonicalName: 'Acme',
    });
  });

  it('profile: a user-bound token for another user gets 404', async () => {
    await expect(
      runWithRequestContext({ correlationId: 'c', authUserId: 'u2' }, () =>
        profile(makeEntities(personal).svc),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('profile by external ref: null for another user, the profile for the owner', async () => {
    const byRef = (userId?: string) =>
      makeEntities(personal).svc.getProfileByExternalRef({
        companyId: 'co_x',
        vertical: 'crm',
        id: '42',
        asOfRaw: undefined,
        userId,
        scopes,
      });
    await expect(byRef()).resolves.toBeNull();
    await expect(byRef('u1')).resolves.toMatchObject({ canonicalName: 'Bob' });
  });

  it('timeline: no canonicalName for another user, the name for the owner', async () => {
    const timeline = (userId?: string) =>
      makeEntities(personal).svc.getTimeline({
        companyId: 'co_x',
        entityIdRaw: 'e1',
        sinceRaw: undefined,
        untilRaw: undefined,
        userId,
        scopes,
      });
    expect((await timeline()).canonicalName).toBeUndefined();
    expect((await timeline('u1')).canonicalName).toBe('Bob');
  });
});

describe('autocomplete scope-tag fence', () => {
  it('a credential acting in a circle gets the circle clause', async () => {
    const { svc, sqls } = makeEntities(shared);
    await runWithRequestContext({ correlationId: 'c', actingCircle: 'family' }, () =>
      svc.autocomplete({ companyId: 'co_x', q: 'ac', limit: 5, scopes }),
    );
    expect(sqls[0]!.sql).toContain('scope ALLINSIDE $acScopeTag');
    expect(sqls[0]!.params.acScopeTag).toEqual(['circle:family']);
  });
});
