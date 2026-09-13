import type { Surreal } from 'surrealdb';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';
import type { IngestFactDto } from '../src/ingest/dto/ingest-fact.dto';

/**
 * External-ref adoption: the structured ingest path must not mint a
 * second entity for a name the graph already knows.
 *
 * `resolveOrCreateEntity` consulted ONE key — `entity_external_ref.key`,
 * i.e. `(vertical, id)`. The mention path consults another — the stored
 * `canonicalNameLc`. Two identity keys, never compared, so a tenant ended
 * up holding BOTH `Meridian` (coined by extraction) and `meridian`
 * (minted by `/v1/ingest/fact` with `id: 'meridian'`) as separate
 * entities, with the payout-cutoff facts split across the two — which is
 * why the competing-facts surface could not find the disagreement it was
 * already storing.
 *
 * The rules this pins are the conservative ones: adopt only a UNIQUE
 * name match, write ONLY the ref row (never rewrite the entity), and
 * fall back to minting whenever the name is unknown or ambiguous.
 */
interface Captured {
  queries: Array<{ sql: string; params: Record<string, unknown> }>;
  creates: Array<{ table: string; content: Record<string, unknown> }>;
  transactions: number;
}

/**
 * A db double: `refRows` answers the external-ref lookup, `nameRows` the
 * canonical-name probe. CREATE and the mint transaction are captured
 * rather than executed.
 */
function makeDb(opts: { refRows?: unknown[]; nameRows?: unknown[] }): {
  db: Surreal;
  captured: Captured;
} {
  const captured: Captured = { queries: [], creates: [], transactions: 0 };
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      captured.queries.push({ sql, params: params ?? {} });
      // The mint path arrives as ONE composed BEGIN…COMMIT string, and it
      // mentions both tables — so it has to be matched before either.
      // runTransaction reads slot length-2 on the 3.x shape (one slot per
      // statement plus BEGIN and COMMIT), so answer with that shape.
      if (sql.startsWith('BEGIN TRANSACTION')) {
        captured.transactions += 1;
        return [null, null, null, { id: 'knowledge_entity:minted' }, null];
      }
      if (sql.includes('FROM entity_external_ref')) return [opts.refRows ?? []];
      if (sql.includes('FROM knowledge_entity')) return [opts.nameRows ?? []];
      // dbCreate goes through `CREATE type::table($t) CONTENT $d`.
      if (sql.includes('CREATE type::table($t)')) {
        captured.creates.push({
          table: String(params?.['t']),
          content: (params?.['d'] ?? {}) as Record<string, unknown>,
        });
        return [[params?.['d'] ?? {}]];
      }
      return [[]];
    },
  } as unknown as Surreal;
  return { db, captured };
}

const dto = (id: string): IngestFactDto =>
  ({
    entityRef: { vertical: 'ledger', id },
    predicate: 'payout_cutoff',
    object: '16:30 UTC',
  }) as IngestFactDto;

describe('resolveOrCreateEntity — external-ref adoption', () => {
  it('adopts the entity the graph already knows by that name', async () => {
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:meridian' }] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('meridian'));
    expect(id).toBe('knowledge_entity:meridian');
    // ONLY the ref row is written; the existing entity is untouched, and
    // no second knowledge_entity is minted.
    expect(captured.transactions).toBe(0);
    expect(captured.creates.map((c) => c.table)).toEqual(['entity_external_ref']);
  });

  it('matches case-insensitively — `meridian` finds `Meridian`', async () => {
    // The stored VALUE field is canonicalNameLc, so the probe lowercases;
    // this is the exact split that produced two Meridian entities.
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:meridian' }] });
    await new EntityUpsertService().resolveOrCreateEntity(db, dto('MERIDIAN'));
    const probe = captured.queries.find((q) => q.sql.includes('FROM knowledge_entity'))!;
    expect(probe.params).toMatchObject({ name: 'meridian', rawName: 'MERIDIAN' });
  });

  it('mints when the name is unknown (historical behaviour)', async () => {
    const { db, captured } = makeDb({ nameRows: [] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('novel-vendor'));
    expect(id).toBe('knowledge_entity:minted');
    expect(captured.transactions).toBe(1);
  });

  it('mints when the name is AMBIGUOUS — two candidates are not an identity', async () => {
    const { db, captured } = makeDb({
      nameRows: [{ id: 'knowledge_entity:a' }, { id: 'knowledge_entity:b' }],
    });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('john smith'));
    expect(id).toBe('knowledge_entity:minted');
    expect(captured.transactions).toBe(1);
  });

  it('never probes when the external ref already resolves', async () => {
    // The fast path must stay one indexed read — adoption is a MISS-path
    // cost only.
    const { db, captured } = makeDb({ refRows: ['knowledge_entity:known'] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('meridian'));
    expect(id).toBe('knowledge_entity:known');
    expect(captured.queries.filter((q) => q.sql.includes('FROM knowledge_entity'))).toEqual([]);
    expect(captured.creates).toEqual([]);
  });

  it('a USER-SCOPED ref never adopts — it mints its own entity (0055 + user-forget)', async () => {
    // The load-bearing negative. 0055 gives a scoped ref its own entity
    // instead of hanging personal facts off the shared node, and
    // user-forget deletes that entity; adopting the tenant-global one
    // would point the erasure at a shared entity. So the probe must not
    // even run.
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:meridian' }] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('meridian'), 'user_a');
    expect(id).toBe('knowledge_entity:minted');
    expect(captured.queries.filter((q) => q.sql.includes('FROM knowledge_entity'))).toEqual([]);
    expect(captured.transactions).toBe(1);
  });

  it('the tenant-global probe is fenced to tenant-global candidates', async () => {
    const { db, captured } = makeDb({ nameRows: [] });
    await new EntityUpsertService().resolveOrCreateEntity(db, dto('meridian'));
    const probe = captured.queries.find((q) => q.sql.includes('FROM knowledge_entity'))!;
    expect(probe.sql).toContain('userId IS NONE');
    expect(probe.params).not.toHaveProperty('scopeUserId');
  });

  it('a bare entityId still short-circuits everything', async () => {
    const { db, captured } = makeDb({});
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, {
      entityRef: { entityId: 'knowledge_entity:direct' },
    } as IngestFactDto);
    expect(id).toBe('knowledge_entity:direct');
    expect(captured.queries).toEqual([]);
  });
});
