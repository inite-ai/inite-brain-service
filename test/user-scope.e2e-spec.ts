/**
 * Per-user memory scope (migration 0055) against a REAL SurrealDB:
 * fail-closed reads (no userId → tenant-global only; user A never sees
 * user B), scope-local conflict resolution (a personal fact never
 * supersedes the tenant-global timeline), scoped entity dedup keys, and
 * the GDPR user-forget cascade.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('per-user memory scope', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_user_scope_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (body: Record<string, unknown>) => {
    const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
      ...body,
    });
    expect([200, 201]).toContain(r.status);
    return r.body;
  };

  const searchObjects = async (query: string, userId?: string) => {
    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query, limit: 10, ...(userId ? { userId } : {}) });
    expect(r.status).toBe(201);
    return (r.body.results as Array<{ facts: Array<{ object: string }> }>)
      .flatMap((h) => h.facts ?? [])
      .map((fa) => fa.object);
  };

  let sharedEntityId: string;

  it('personal facts are invisible without the right userId (fail-closed)', async () => {
    const anchor = await ingest({
      entityRef: { vertical: 'rent', id: 'scope_subject' },
      predicate: 'name',
      object: 'Scope Probe Subject',
    });
    const surreal = f.app.get(SurrealService);
    sharedEntityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: (anchor.factId as string).split(':')[1] },
      );
      return String((rows as Array<{ entityId: unknown }>)[0].entityId);
    });

    await ingest({
      entityRef: { entityId: sharedEntityId },
      predicate: 'note_probe',
      object: 'prefers quiet upper floors',
      userId: 'user_a',
    });
    await ingest({
      entityRef: { entityId: sharedEntityId },
      predicate: 'note_probe',
      object: 'needs covered parking spot',
      userId: 'user_b',
    });

    // No userId → tenant-global only.
    expect(await searchObjects('quiet upper floors')).not.toContain(
      'prefers quiet upper floors',
    );
    // Right user sees their own row (plus global memory).
    expect(await searchObjects('quiet upper floors', 'user_a')).toContain(
      'prefers quiet upper floors',
    );
    // Another user never sees it.
    expect(await searchObjects('quiet upper floors', 'user_b')).not.toContain(
      'prefers quiet upper floors',
    );
    // And a user request still sees the tenant-global memory.
    expect(await searchObjects('Scope Probe Subject', 'user_a')).toContain(
      'Scope Probe Subject',
    );
  });

  it('conflict resolution is scope-local: a personal fact never touches the global timeline', async () => {
    const globalTier = await ingest({
      entityRef: { entityId: sharedEntityId },
      predicate: 'tier',
      object: 'gold',
    });
    expect(globalTier.outcome).toBe('INSERTED');

    // Same single_active predicate, same entity — but user-scoped: the
    // global 'gold' must stay active, the personal row lands INSERTED.
    const personalTier = await ingest({
      entityRef: { entityId: sharedEntityId },
      predicate: 'tier',
      object: 'platinum',
      userId: 'user_a',
    });
    expect(personalTier.outcome).toBe('INSERTED');

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ status: string }>]>(
        `SELECT status FROM type::record('knowledge_fact', $tail)`,
        { tail: (globalTier.factId as string).split(':')[1] },
      );
      expect((rows as Array<{ status: string }>)[0].status).toBe('active');
    });
  });

  it('a vertical+id ref with userId mints a scoped entity, not the global one', async () => {
    const personal = await ingest({
      entityRef: { vertical: 'rent', id: 'scope_subject' },
      predicate: 'name',
      object: 'My Private View Of Subject',
      userId: 'user_a',
    });
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ entityId: unknown; userId: string | null }>]
      >(
        `SELECT entityId, entityId.userId AS userId FROM type::record('knowledge_fact', $tail)`,
        { tail: (personal.factId as string).split(':')[1] },
      );
      const row = (
        rows as Array<{ entityId: unknown; userId: string | null }>
      )[0];
      expect(String(row.entityId)).not.toBe(sharedEntityId);
      expect(row.userId).toBe('user_a');
    });
  });

  it('user forget erases exactly that user, nothing else', async () => {
    const forget = await f.http
      .post('/v1/users/user_a/forget')
      .set(auth())
      .send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.factsDeleted).toBeGreaterThanOrEqual(3);
    expect(forget.body.entitiesDeleted).toBeGreaterThanOrEqual(1);

    expect(await searchObjects('quiet upper floors', 'user_a')).not.toContain(
      'prefers quiet upper floors',
    );
    // user_b's personal memory and the global timeline survive.
    expect(await searchObjects('covered parking', 'user_b')).toContain(
      'needs covered parking spot',
    );
    expect(await searchObjects('Scope Probe Subject')).toContain(
      'Scope Probe Subject',
    );

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM knowledge_fact WHERE userId = 'user_a' GROUP ALL`,
      );
      expect((rows as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
    });
  });
});
