/**
 * Two people who share a name, mentioned in two conversations with no
 * userId, stay two entities — through the real mention ingest, the real
 * naming ladder and the real SurrealDB reads (#815).
 *
 * The extractor is the stub (it files exactly what the issue's two
 * sentences yield: the city and the employer as edges, the profession as a
 * fact). The judge is held at "unsure" — what it answers when it hedges and
 * also when its call fails — which is the verdict that used to keep the
 * reuse whatever the facts said. No model is called.
 */
process.env.INGEST_INLINE_RESOLUTION_ENABLED = '1';

import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { EntityJudgeService } from '../src/ai/entity-judge.service';
import type { ExtractionResult } from '../src/ai/extractor.service';
import { SurrealService } from '../src/db/surreal.service';

describe('same name, different person — mention ingest (#815)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const ingest = async (text: string, conversationId: string) => {
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        contextRef: { vertical: 'chat', conversationId },
        emittedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
  };

  const annas = async (name: string): Promise<string[]> =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_entity WHERE canonicalName = $name`,
        { name },
      );
      return (rows ?? []).map((r) => String(r.id));
    });

  /** "Our vet <name> runs a small animal clinic in Munich; she has treated our dog for years." */
  const vet = (name: string): ExtractionResult => ({
    entities: [
      { name, type: 'staff' },
      { name: 'Munich', type: 'location' },
    ],
    facts: [
      { entityIndex: 0, predicate: 'occupation', object: 'vet', confidence: 0.9 },
      { entityIndex: 0, predicate: 'runs', object: 'small animal clinic', confidence: 0.9 },
    ],
    edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'located_in', confidence: 0.9 }],
  });

  /** "<name> joined Orbital as a software engineer in Lisbon last spring; she writes Rust." */
  const engineer = (name: string): ExtractionResult => ({
    entities: [
      { name, type: 'staff' },
      { name: 'Orbital', type: 'organization' },
      { name: 'Lisbon', type: 'location' },
    ],
    facts: [
      { entityIndex: 0, predicate: 'role', object: 'software engineer', confidence: 0.9 },
      { entityIndex: 0, predicate: 'writes', object: 'Rust', confidence: 0.9 },
    ],
    edges: [
      { fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at', confidence: 0.9 },
      { fromEntityIndex: 0, toEntityIndex: 2, kind: 'lives_in', confidence: 0.9 },
    ],
  });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_same_name_people_e2e' });
    const judge = f.app.get(EntityJudgeService);
    jest.spyOn(judge, 'isAvailable').mockReturnValue(true);
    jest.spyOn(judge, 'judge').mockResolvedValue('unsure');
  });

  afterAll(async () => {
    if (f) await f.close();
    jest.restoreAllMocks();
  });

  it('the Munich vet and the Lisbon engineer are two entities', async () => {
    f.extractor.setScript(vet('Anna Schmidt'));
    await ingest('Our vet Anna Schmidt runs a small animal clinic in Munich.', 'vet');
    f.extractor.setScript(engineer('Anna Schmidt'));
    await ingest('Anna Schmidt joined Orbital as a software engineer in Lisbon.', 'work');
    expect(await annas('Anna Schmidt')).toHaveLength(2);

    // And each comes back to her own: the vet again, the engineer again.
    f.extractor.setScript(vet('Anna Schmidt'));
    await ingest('Anna Schmidt, our vet in Munich, saw the dog today.', 'vet-2');
    f.extractor.setScript(engineer('Anna Schmidt'));
    await ingest('Anna Schmidt from Orbital in Lisbon shipped the Rust port.', 'work-2');
    expect(await annas('Anna Schmidt')).toHaveLength(2);
  });

  it('one person mentioned again in another conversation stays one', async () => {
    f.extractor.setScript(vet('Clara Weiss'));
    await ingest('Our vet Clara Weiss runs a small animal clinic in Munich.', 'c1');
    // Nothing about who she is: no attribute to contradict.
    f.extractor.setScript({
      entities: [{ name: 'Clara Weiss', type: 'staff' }],
      facts: [{ entityIndex: 0, predicate: 'recommended', object: 'a new diet', confidence: 0.9 }],
      edges: [],
    });
    await ingest('Clara Weiss recommended a new diet.', 'c2');
    expect(await annas('Clara Weiss')).toHaveLength(1);
  });
});
