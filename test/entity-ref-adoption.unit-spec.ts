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
function makeDb(opts: {
  /** Rows of the external-ref lookup: an id, or { entity, chain } verbatim. */
  refRows?: unknown[];
  nameRows?: unknown[];
  /** `externalRefs` of the entity the name probe returns. */
  candidateRefs?: Record<string, string>;
}): {
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
      if (sql.includes('FROM entity_external_ref')) {
        // The lookup now projects the merge chain beside the entity, so a
        // reference to an absorbed entity resolves to its survivor.
        return [
          (opts.refRows ?? []).map((r) => (typeof r === 'string' ? { entity: r, chain: [] } : r)),
        ];
      }
      // The adoption guard's own read: which ids is the candidate keyed by?
      if (sql.includes('VALUE externalRefs')) return [opts.candidateRefs ?? {}];
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

  it('declines a candidate that carries that id as its OWN external reference', async () => {
    // `rent/jonas` and `events/jonas` are two id-spaces that collide on a
    // key, not one person. Adopting across the collision fuses two referents
    // into a node nothing can take apart again — and it turned the operator's
    // own identity_of declaration between them into a 400 self-merge.
    const { db, captured } = makeDb({
      nameRows: [{ id: 'knowledge_entity:rent_jonas' }],
      candidateRefs: { rent__jonas: 'jonas' },
    });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('jonas'));
    expect(id).toBe('knowledge_entity:minted');
    expect(captured.transactions).toBe(1);
  });

  it('declines across scripts too — a transliterated key collides just as blindly', async () => {
    const { db } = makeDb({
      nameRows: [{ id: 'knowledge_entity:crm_ivan' }],
      candidateRefs: { crm__Иван: 'Иван' },
    });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('Ivan'));
    expect(id).toBe('knowledge_entity:minted');
  });

  it('adopts when the match is a name the graph LEARNED, not a sibling key', async () => {
    // The candidate is keyed by `acme` and known as "Acme Corp" (coined by
    // extraction, or stated by a name fact). A reference spelling the learned
    // name is the #593 case and still adopts.
    const { db, captured } = makeDb({
      nameRows: [{ id: 'knowledge_entity:acme' }],
      candidateRefs: { ledger__acme: 'acme' },
    });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('Acme Corp'));
    expect(id).toBe('knowledge_entity:acme');
    expect(captured.transactions).toBe(0);
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

  it('a USER-SCOPED ref names the same tenant node — adopted by name, keyed tenant-wide', async () => {
    // Identity is tenant-wide, scope is on the fact (2026-09-20): the
    // reference resolves and adopts exactly like a tenant-global write —
    // the plain key, the same tenant-global-only probe — and the personal
    // fact rides on the shared node with its own userId. The 0055 private
    // copy split one referent across two nodes (memfit D2/D6).
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:meridian' }] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(db, dto('meridian'), 'user_a');
    expect(id).toBe('knowledge_entity:meridian');
    expect(captured.creates).toEqual([
      {
        table: 'entity_external_ref',
        content: { key: 'ledger__meridian', entity: expect.anything() },
      },
    ]);
    const probe = captured.queries.find((q) => q.sql.includes('FROM knowledge_entity'))!;
    expect(probe.sql).toContain('userId IS NONE');
    expect(captured.transactions).toBe(0);
  });

  it("the user's OWN reference stays private: scoped key, no adoption, personal node", async () => {
    const { db, captured } = makeDb({ nameRows: [{ id: 'knowledge_entity:someone' }] });
    const id = await new EntityUpsertService().resolveOrCreateEntity(
      db,
      {
        entityRef: { vertical: 'user', id: 'user_a' },
        predicate: 'name',
        object: 'Sasha',
      } as IngestFactDto,
      'user_a',
    );
    expect(id).toBe('knowledge_entity:minted');
    expect(captured.queries.filter((q) => q.sql.includes('FROM knowledge_entity'))).toEqual([]);
    const lookup = captured.queries.find((q) => q.sql.includes('FROM entity_external_ref'))!;
    expect(lookup.params).toMatchObject({ key: 'user__user_a::u::user_a' });
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
