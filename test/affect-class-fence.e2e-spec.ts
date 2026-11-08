/**
 * #909 step 1, end to end on a real SurrealDB: how a person said they feel
 * is served only to a credential holding brain:read_pii.
 *
 *  - A tenant that installed relationship 0.2.0 holds `stated_affect`
 *    classed `sensitive` with no `requiresScope`; before 0185 any
 *    brain:read caller read it in relationship_context. The class is now
 *    the fence.
 *  - The same predicate classed `affect` (0.3.0) fences the same way.
 *  - A belief stamped `affect` (0185) is invisible to GET-style belief
 *    reads without brain:read_pii; an unclassed belief reads as before.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EntitiesService } from '../src/entities/entities.service';
import { BeliefsService } from '../src/beliefs/beliefs.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { BrainScope } from '../src/auth/api-key.types';

const READ: BrainScope[] = ['brain:read'];
const READ_PII: BrainScope[] = ['brain:read', 'brain:read_pii'];

describe('affect class fence (0185)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const USER = 'affect_user';
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: `co_affect_${Date.now()}` });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const setClass = async (piiClass: string) => {
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `DELETE knowledge_predicate WHERE predicateId = 'relationship__stated_affect';
         CREATE knowledge_predicate CONTENT {
           predicateId: 'relationship__stated_affect', displayLabel: 'stated affect',
           description: 'how the person says they feel', datatype: 'string',
           semantics: 'single_active', decayHalfLifeDays: 7, piiClass: $c,
           status: 'active', createdBy: 'system' };`,
        { c: piiClass },
      );
    });
    f.app.get(PredicateRegistryService).invalidate(f.companyId);
  };

  const stateFor = async (scopes: BrainScope[]) =>
    (
      await f.app
        .get(EntitiesService)
        .getRelationshipContext({ companyId: f.companyId, userId: USER, scopes })
    ).state;

  it.each(['sensitive', 'affect'])(
    'stated_affect classed %s: hidden from brain:read, served to brain:read_pii',
    async (piiClass) => {
      await setClass(piiClass);
      const r = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'chat', id: USER },
          predicate: 'relationship__stated_affect',
          object: `exhausted (${piiClass})`,
          validFrom: new Date().toISOString(),
          userId: USER,
          confidence: 0.9,
          source: { vertical: 'chat', recorder: 'test' },
        });
      expect([200, 201]).toContain(r.status);

      expect((await stateFor(READ)).known).toBe(false);
      const withPii = await stateFor(READ_PII);
      expect(withPii.known).toBe(true);
    },
  );

  it('an affect belief needs brain:read_pii; an unclassed one reads as before', async () => {
    await surreal.withCompany(f.companyId, async (db) => {
      for (const [field, piiClass] of [
        ['mood', 'affect'],
        ['database', undefined],
      ] as const) {
        await db.query(
          `CREATE semantic_belief CONTENT {
             userId: $u, subject: 'person', field: $field, value: 'v',
             statement: $field, statementSource: 'template', confidence: 0.8,
             revision: 1, status: 'active', validFrom: time::now(),
             sourceSceneIds: [], conversationIds: [], promoterVersion: 'test',
             piiClass: $c };`,
          { u: USER, field, c: piiClass },
        );
      }
    });
    const beliefs = f.app.get(BeliefsService);
    const fields = async (scopes: BrainScope[]) =>
      (
        await beliefs.listBeliefs({
          companyId: f.companyId,
          scopes,
          userId: USER,
          status: 'active',
          limit: 25,
        })
      ).beliefs
        .map((b) => b.field)
        .sort();
    expect(await fields(READ)).toEqual(['database']);
    expect(await fields(READ_PII)).toEqual(['database', 'mood']);
  });
});
