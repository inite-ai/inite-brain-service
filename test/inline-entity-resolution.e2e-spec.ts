/**
 * Inline entity resolution — ingest wiring (end-to-end).
 *
 * Verifies the mention path honours EntityResolverService's verdict:
 *   - resolver says "reuse <id>" → the second mention's facts land on the
 *     EXISTING entity; no near-duplicate entity is created.
 *   - resolver says "create new" (null) → a distinct entity is minted, as
 *     before the feature.
 *
 * The resolver's own cosine+LLM logic is unit-tested; here we stub
 * resolveByName (the embedder stub gives ~0 cosine for differing text, and
 * we don't want a live LLM) and assert the INGEST side reacts correctly.
 */
process.env.INGEST_INLINE_RESOLUTION_ENABLED = '1';

import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EntityResolverService } from '../src/ingest/entity-resolver.service';

describe('Inline entity resolution — mention ingest wiring', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const ingestMention = async (text: string) => {
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        contextRef: { vertical: 'rent', conversationId: 'conv_inline' },
        emittedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const entityIdByName = async (name: string): Promise<string | null> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_entity WHERE canonicalName = $name`,
        { name },
      );
      const arr = (rows as any[]) ?? [];
      return arr.length ? String(arr[0].id) : null;
    });
  };

  const countByName = async (name: string): Promise<number> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_entity WHERE canonicalName = $name`,
        { name },
      );
      return ((rows as any[]) ?? []).length;
    });
  };

  const predicatesOf = async (entityId: string): Promise<string[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT predicate FROM knowledge_fact
           WHERE entityId = type::thing('knowledge_entity', $tail)`,
        { tail: entityId.split(':')[1] },
      );
      return ((rows as any[]) ?? []).map((r) => String(r.predicate));
    });
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_inline_resolution_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
    jest.restoreAllMocks();
  });

  it('reuses the existing entity when the resolver confirms a match', async () => {
    // Mention 1 → mints "Acme Inc" with an `industry` fact.
    f.extractor.setScript({
      entities: [{ name: 'Acme Inc', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'industry', object: 'software', confidence: 0.9 },
      ],
      edges: [],
    });
    await ingestMention('first mention about acme');
    const acmeId = await entityIdByName('Acme Inc');
    expect(acmeId).toBeTruthy();

    // Resolver confirms the near-duplicate is the same entity.
    const resolver = f.app.get(EntityResolverService);
    jest.spyOn(resolver, 'resolveByName').mockResolvedValue(acmeId);

    // Mention 2 → different surface name + a `tier` fact.
    f.extractor.setScript({
      entities: [{ name: 'Acme Incorporated', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 },
      ],
      edges: [],
    });
    await ingestMention('second mention about acme incorporated');

    // No duplicate entity, and the tier fact landed on the original.
    expect(await countByName('Acme Incorporated')).toBe(0);
    const preds = await predicatesOf(acmeId!);
    expect(preds).toContain('industry');
    expect(preds).toContain('tier');
  });

  it('mints a distinct entity when the resolver declines', async () => {
    const resolver = f.app.get(EntityResolverService);
    jest.spyOn(resolver, 'resolveByName').mockResolvedValue(null);

    f.extractor.setScript({
      entities: [{ name: 'Globex Ltd', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'silver', confidence: 0.9 },
      ],
      edges: [],
    });
    await ingestMention('globex first');

    f.extractor.setScript({
      entities: [{ name: 'Globex Limited', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 },
      ],
      edges: [],
    });
    await ingestMention('globex second');

    // Resolver said "new" → a separate entity exists.
    expect(await countByName('Globex Ltd')).toBe(1);
    expect(await countByName('Globex Limited')).toBe(1);
  });
});
