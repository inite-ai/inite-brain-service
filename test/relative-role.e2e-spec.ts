/**
 * Relatives named by role are personal, end to end against a real
 * SurrealDB. Found by HaluMem: two users' "Father" became one entity
 * holding both users' fathers' birth dates.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('relatives named by role (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const parentSaid = (relative: string, dob: string) => ({
    entities: [{ name: relative, type: 'customer' as const }],
    facts: [{ entityIndex: 0, predicate: 'dob', object: dob, confidence: 0.9 }],
    edges: [],
  });

  const mention = (text: string, userId: string | undefined, messageId: string) =>
    f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        emittedAt: '2026-09-25T10:00:00.000Z',
        ...(userId ? { userId } : {}),
        contextRef: { vertical: 'chat', conversationId: `c-${messageId}`, messageId },
      })
      .expect(201);

  const dobRows = () =>
    f.app.get(SurrealService).withCompany(
      f.companyId,
      async (db) =>
        (
          await db.query<
            [
              Array<{
                object: string;
                userId?: string;
                entity: string;
                entityUser?: string;
                name: string;
              }>,
            ]
          >(
            `SELECT object, userId, <string> entityId AS entity, entityId.userId AS entityUser,
                    entityId.canonicalName AS name
               FROM knowledge_fact WHERE predicate = 'dob' ORDER BY object`,
          )
        )[0] ?? [],
    );

  it("two users' fathers are two people, each the user's own", async () => {
    f.extractor.setScript(parentSaid('Father', '1963-08-02'));
    await mention('Martin: My Father was born on 1963-08-02.', 'u-martin', 'm1');
    f.extractor.setScript(parentSaid('Father', '1968-05-11'));
    await mention('Johnson: My Father was born on 1968-05-11.', 'u-johnson', 'm2');

    const rows = await dobRows();
    expect(rows.map((r) => [r.object, r.userId, r.entityUser, r.name])).toEqual([
      ['1963-08-02', 'u-martin', 'u-martin', 'Father'],
      ['1968-05-11', 'u-johnson', 'u-johnson', 'Father'],
    ]);
    expect(rows[0]!.entity).not.toBe(rows[1]!.entity);
  });

  it('"my dad" later is the same person for the same user', async () => {
    const before = (await dobRows()).find((r) => r.userId === 'u-martin')!.entity;
    f.extractor.setScript(parentSaid('my dad', '1963-08-02'));
    await mention('Martin: my dad was born on 1963-08-02, as I said.', 'u-martin', 'm3');
    const martin = (await dobRows()).filter((r) => r.userId === 'u-martin');
    expect(new Set(martin.map((r) => r.entity))).toEqual(new Set([before]));
  });

  it('without a user the mention resolves as before — tenant-wide', async () => {
    f.extractor.setScript(parentSaid('Mother', '1970-01-01'));
    await mention('Note: Mother was born on 1970-01-01.', undefined, 'm4');
    const row = (await dobRows()).find((r) => r.object === '1970-01-01')!;
    expect(row.entityUser ?? null).toBeNull();
    expect(row.name).toBe('Mother');
  });
});
