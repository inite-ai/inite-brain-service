/**
 * link_entities / POST /v1/ingest/link under a user-bound token: the
 * edge lands in that user's memory (userId stamped, 0055), and an
 * identity_of merge may only fold an entity of the user's own memory —
 * never a tenant-global one, which would redirect it for every reader.
 * An M2M credential keeps declaring tenant-global relations and merges.
 */
import { ForbiddenException } from '@nestjs/common';
import { LinkIngestService } from '../src/ingest/link-ingest.service';
import type { EntityUpsertService } from '../src/ingest/entity-upsert.service';
import type { SurrealService } from '../src/db/surreal.service';
import { runWithRequestContext } from '../src/common/request-context';

function harness(owners: Record<string, string | undefined>) {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT VALUE userId')) {
        return [[owners[String(params.loser)]], [owners[String(params.survivor)]]];
      }
      if (sql.includes('fn::merge_identity')) return [{ merged: true, reason: null }];
      if (sql.includes('RELATE')) return [[{ id: 'knowledge_edge:x' }]];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  const entities = {
    resolveOrCreateBareRef: async (_db: unknown, ref: { entityId: string }) =>
      `knowledge_entity:${ref.entityId}`,
  } as unknown as EntityUpsertService;
  return { svc: new LinkIngestService(surreal, entities), queries };
}

const link = (svc: LinkIngestService, kind: string) =>
  svc.ingestLink('co_t', {
    from: { entityId: 'a' },
    to: { entityId: 'b' },
    kind,
    source: { vertical: 'x' },
  } as never);
const asUser = <T>(fn: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'c', authUserId: 'u1' }, fn);

describe('link ingest per-user scope', () => {
  it('an M2M edge is tenant-global', async () => {
    const { svc, queries } = harness({});
    await link(svc, 'works_with');
    const relate = queries.find((q) => q.sql.includes('RELATE'))!;
    expect(relate.params.userId).toBeUndefined();
  });

  it('a user-bound token’s edge is stamped with its user', async () => {
    const { svc, queries } = harness({});
    await asUser(() => link(svc, 'works_with'));
    const relate = queries.find((q) => q.sql.includes('RELATE'))!;
    expect(relate.params.userId).toBe('u1');
  });

  it('a user-bound token may not merge two tenant-global entities', async () => {
    const { svc, queries } = harness({});
    await expect(asUser(() => link(svc, 'identity_of'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries.some((q) => q.sql.includes('fn::merge_identity'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('RELATE'))).toBe(false);
  });

  it('a user-bound token may not merge another user’s entity', async () => {
    const { svc } = harness({ b: 'u2' });
    await expect(asUser(() => link(svc, 'identity_of'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a user-bound token merges its own entity into a global one', async () => {
    const { svc, queries } = harness({ b: 'u1' });
    await asUser(() => link(svc, 'identity_of'));
    expect(queries.some((q) => q.sql.includes('fn::merge_identity'))).toBe(true);
  });

  it('an M2M credential merges tenant-global entities as before', async () => {
    const { svc, queries } = harness({});
    await link(svc, 'identity_of');
    expect(queries.some((q) => q.sql.includes('SELECT VALUE userId'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('fn::merge_identity'))).toBe(true);
  });
});
