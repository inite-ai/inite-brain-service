/**
 * The user's own entity (src/ingest/user-entity.ts) through the two
 * services that touch it:
 *
 *  EntityUpsertService.resolveOrCreateNamedEntity, hint path —
 *   - the user's own reference is minted under the SCOPED key as a
 *     personal entity (userId + scope tag), never adopting a shared
 *     node; the same key the typed fact path uses for that ref;
 *   - a third-party speaker ref keeps the tenant-global key and adopts;
 *   - the participant's display name reaches the entity: alias, name
 *     key, and — while the entity is still named by its ref id — the
 *     canonical name itself; a name equal to the ref id stamps nothing.
 *
 *  UserEntityService —
 *   - lookup reads the ref row by the scoped key and follows a merge;
 *   - participants() names the user from the caller, else the entity,
 *     else the token, else the userId; a name the caller (or the token)
 *     gives reaches the entity; a declared third-party speaker skips
 *     the read entirely.
 */
import type { Surreal } from 'surrealdb';
import { EntityUpsertService, participantSurfaces } from '../src/ingest/entity-upsert.service';
import { UserEntityService } from '../src/ingest/user-entity.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import { runWithRequestContext } from '../src/common/request-context';

interface Captured {
  queries: Array<{ sql: string; params: Record<string, unknown> }>;
  minted: Record<string, unknown>[];
}

function makeDb(opts: { refRows?: unknown[]; nameRows?: unknown[] } = {}) {
  const captured: Captured = { queries: [], minted: [] };
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      captured.queries.push({ sql, params: params ?? {} });
      if (sql.startsWith('BEGIN TRANSACTION')) {
        captured.minted.push((params?.['content'] ?? {}) as Record<string, unknown>);
        return [null, null, null, { id: 'knowledge_entity:minted' }, null];
      }
      if (sql.includes('FROM entity_external_ref')) return [opts.refRows ?? []];
      if (sql.includes('FROM knowledge_entity')) return [opts.nameRows ?? []];
      if (sql.includes('CREATE type::table($t)')) return [[params?.['d'] ?? {}]];
      return [[]];
    },
  } as unknown as Surreal;
  return { db, captured };
}

const e = { name: 'I', type: 'customer' };

describe('participantSurfaces — what a hint-minted participant is born named', () => {
  it("the caller's name is canonical; a pronoun mention names nothing; other forms are aliases", () => {
    expect(participantSurfaces({ name: 'I' }, { name: 'Sasha' })).toEqual({
      canonical: 'Sasha',
      aliases: ['Sasha'],
    });
    expect(
      participantSurfaces({ name: 'Ana', canonical: 'Ana Costa' }, { name: 'Ana C.' }),
    ).toEqual({
      canonical: 'Ana C.',
      aliases: ['Ana C.', 'Ana Costa', 'Ana'],
    });
    expect(participantSurfaces({ name: 'Rui' }, {})).toEqual({
      canonical: 'Rui',
      aliases: ['Rui'],
    });
    // A pronoun and no caller name: the mention's form is all there is.
    expect(participantSurfaces({ name: 'me' }, {})).toEqual({ canonical: 'me', aliases: ['me'] });
  });
});

describe('resolveOrCreateNamedEntity — the user’s own reference', () => {
  it('mints under the scoped key as a personal entity and never adopts a shared node', async () => {
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:shared-sasha' }] });
    const id = await new EntityUpsertService().resolveOrCreateNamedEntity({
      db,
      e: { name: 'Sasha', type: 'customer' },
      hint: { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha', userId: 'u42' },
      _contextRef: { vertical: 'personal' },
    });
    expect(id).toBe('knowledge_entity:minted');
    const refLookup = captured.queries.find((q) => q.sql.includes('FROM entity_external_ref'))!;
    expect(refLookup.params['key']).toBe('user__u42::u::u42');
    // No name probe — a scoped ref adopts nothing.
    expect(captured.queries.filter((q) => q.sql.includes('FROM knowledge_entity'))).toEqual([]);
    expect(captured.minted[0]).toMatchObject({
      canonicalName: 'Sasha',
      userId: 'u42',
      scope: ['user:u42'],
      externalRefs: { 'user__u42::u::u42': 'u42' },
    });
  });

  it('a third-party speaker keeps the tenant-global key and adopts the known name', async () => {
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:ana' }] });
    const id = await new EntityUpsertService().resolveOrCreateNamedEntity({
      db,
      e: { name: 'Ana', type: 'customer' },
      hint: { vertical: 'crm', id: 'ana', role: 'speaker', name: 'Ana' },
      _contextRef: { vertical: 'crm' },
    });
    expect(id).toBe('knowledge_entity:ana');
    const refLookup = captured.queries.find((q) => q.sql.includes('FROM entity_external_ref'))!;
    expect(refLookup.params['key']).toBe('crm__ana');
    expect(captured.minted).toEqual([]);
  });

  it("the participant's name reaches an existing entity: alias, name key, and the ref-id placeholder", async () => {
    const { db, captured } = makeDb({ refRows: ['knowledge_entity:u42'] });
    await new EntityUpsertService().resolveOrCreateNamedEntity({
      db,
      e,
      hint: { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha', userId: 'u42' },
      _contextRef: { vertical: 'personal' },
    });
    const alias = captured.queries.find((q) => q.sql.includes('SET aliases'))!;
    expect(alias.params['add']).toEqual(['Sasha']);
    expect(captured.queries.some((q) => q.sql.includes('SET nameKeys'))).toBe(true);
    const rename = captured.queries.find((q) => q.sql.includes('SET canonicalName'))!;
    expect(rename.sql).toContain('WHERE canonicalName = $refId');
    expect(rename.params).toMatchObject({ name: 'Sasha', refId: 'u42' });
  });

  it('a name that is the ref id itself stamps nothing', async () => {
    const { db, captured } = makeDb({ refRows: ['knowledge_entity:u42'] });
    await new EntityUpsertService().resolveOrCreateNamedEntity({
      db,
      e,
      hint: { vertical: 'user', id: 'u42', role: 'speaker', name: 'u42', userId: 'u42' },
      _contextRef: { vertical: 'personal' },
    });
    expect(captured.queries.some((q) => q.sql.includes('SET '))).toBe(false);
  });
});

function makeUsers(rows: Array<Record<string, unknown>>, fail = false) {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params: params ?? {} });
      if (fail) throw new Error('db down');
      return [rows];
    },
  } as unknown as Surreal;
  const surreal = {
    withCompany: async (_c: string, fn: (d: Surreal) => Promise<unknown>) => fn(db),
  };
  const named: Array<{ entityId: string; id: string; name?: string | undefined }> = [];
  const entities = {
    nameParticipant: jest.fn(
      async (_d: unknown, entityId: string, hint: { id: string; name?: string }) => {
        named.push({ entityId, ...hint });
      },
    ),
  };
  return { svc: new UserEntityService(surreal as never, entities as never), queries, db, named };
}

const dto = (over: Partial<IngestMentionDto> = {}): IngestMentionDto =>
  ({
    text: 'I moved to Berlin.',
    contextRef: { vertical: 'chat' },
    emittedAt: '2026-09-19T10:00:00.000Z',
    userId: 'u42',
    ...over,
  }) as IngestMentionDto;

describe('UserEntityService', () => {
  it('lookup reads the ref row by the scoped key and reports whether the entity is named', async () => {
    const { svc, queries, db } = makeUsers([
      { id: 'knowledge_entity:x', canonicalName: 'Sasha', mergedInto: null },
    ]);
    expect(await svc.lookup(db, 'u42')).toEqual({
      id: 'knowledge_entity:x',
      name: 'Sasha',
      named: true,
    });
    expect(queries[0]!.params['key']).toBe('user__u42::u::u42');
    const placeholder = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'u42' }]);
    expect(await placeholder.svc.lookup(placeholder.db, 'u42')).toMatchObject({ named: false });
    const merged = makeUsers([
      { id: 'knowledge_entity:x', canonicalName: 'Sasha', mergedInto: 'knowledge_entity:y' },
    ]);
    expect((await merged.svc.lookup(merged.db, 'u42'))?.id).toBe('knowledge_entity:y');
    const none = makeUsers([]);
    expect(await none.svc.lookup(none.db, 'u42')).toBeNull();
  });

  it('resolve degrades to null when the store fails', async () => {
    const { svc } = makeUsers([], true);
    expect(await svc.resolve('co', 'u42')).toBeNull();
  });

  it("participants(): the entity's name, else the token's, else the userId", async () => {
    const named = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'Sasha' }]);
    expect((await named.svc.participants('co', dto())).knownEntities).toEqual([
      { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' },
    ]);
    const fromToken = makeUsers([]);
    const viaToken = await runWithRequestContext(
      { correlationId: 't', authUserId: 'u42', authUserName: 'Mike' },
      () => fromToken.svc.participants('co', dto()),
    );
    expect(viaToken.knownEntities?.[0]?.name).toBe('Mike');
    const placeholder = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'u42' }]);
    expect((await placeholder.svc.participants('co', dto())).knownEntities?.[0]?.name).toBe('u42');
  });

  it("participants(): the caller's name for the user reaches the entity, whatever rung the turn resolves through", async () => {
    const { svc, named } = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'u42' }]);
    const anchored = dto({
      knownEntities: [{ vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' }],
    });
    expect(await svc.participants('co', anchored)).toBe(anchored);
    expect(named).toEqual([{ entityId: 'knowledge_entity:x', id: 'u42', name: 'Sasha' }]);
    // The token's name names it too; a name the entity already carries is not re-stamped.
    const viaToken = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'u42' }]);
    await runWithRequestContext(
      { correlationId: 't', authUserId: 'u42', authUserName: 'Mike' },
      () => viaToken.svc.participants('co', dto()),
    );
    expect(viaToken.named).toEqual([{ entityId: 'knowledge_entity:x', id: 'u42', name: 'Mike' }]);
    const same = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'Sasha' }]);
    await same.svc.participants('co', anchored);
    expect(same.named).toEqual([]);
    // No entity yet → nothing to name; the anchor still carries the name into the turn.
    const none = makeUsers([]);
    await none.svc.participants('co', anchored);
    expect(none.named).toEqual([]);
  });

  it('participants(): a declared third-party speaker or a tenant-global turn skips the read', async () => {
    const { svc, queries } = makeUsers([{ id: 'knowledge_entity:x', canonicalName: 'Other' }]);
    const relayed = dto({
      knownEntities: [{ vertical: 'crm', id: 'ana', role: 'speaker', name: 'Ana' }],
    });
    expect(await svc.participants('co', relayed)).toBe(relayed);
    const global = dto({ userId: undefined });
    expect(await svc.participants('co', global)).toBe(global);
    expect(queries).toEqual([]);
  });
});
