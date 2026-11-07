/**
 * #909 step 2 on a real SurrealDB: a fact read says where the claim came
 * from — the predicate's declaration (0186, `knowledge_predicate.assertion`)
 * or the writer's stamp in `source`, else stated.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FactsService } from '../src/facts/facts.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { BrainScope } from '../src/auth/api-key.types';

const SCOPES: BrainScope[] = ['brain:read', 'brain:read_pii'];

describe('claim assertion (0186)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: `co_assert_${Date.now()}` });
    await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE knowledge_predicate CONTENT {
           predicateId: 'relationship__hypothesis', displayLabel: 'open hypothesis',
           description: 'a guess put to the person', datatype: 'string',
           semantics: 'append_only', piiClass: 'affect', assertion: 'hypothesis',
           status: 'active', createdBy: 'system' };`,
      );
    });
    f.app.get(PredicateRegistryService).invalidate(f.companyId);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const write = async (predicate: string, object: string, source: Record<string, unknown> = {}) => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'chat', id: 'ana' },
        predicate,
        object,
        validFrom: new Date().toISOString(),
        confidence: 0.9,
        source: { vertical: 'chat', recorder: 'test', ...source },
      });
    expect([200, 201]).toContain(r.status);
    return r.body.factId as string;
  };

  const assertionOfFact = async (factId: string) =>
    f.app.get(FactsService).getFact({ companyId: f.companyId, factId, scopes: SCOPES });

  it('a guess under a predicate that declares it reads as hypothesis', async () => {
    const id = await write('relationship__hypothesis', 'coach: anxious about work');
    expect((await assertionOfFact(id)).assertion).toBe('hypothesis');
  });

  it('an ordinary fact reads as stated', async () => {
    const id = await write('preference', 'likes hiking');
    const fact = await assertionOfFact(id);
    expect(fact.assertion).toBe('stated');
    expect(fact.inferredBy).toBeUndefined();
  });
});
