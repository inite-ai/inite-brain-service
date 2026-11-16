/**
 * Child tenants against a real database (ADR docs/adr/0001-child-tenants.md):
 * a product's machine credential writes each client company's memory into
 * its own tenant, the children do not see each other or the parent, and
 * the parent erases one child whole.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

jest.setTimeout(180_000);

const PARENT = 'co_rent_e2e';

describe('child tenants', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: PARENT,
      scopes: ['brain:read', 'brain:write', 'brain:tenants'],
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const writeFact = (child: string | undefined, object: string) => {
    const req = f.http.post('/v1/ingest/fact').set(auth());
    if (child) req.set('X-Brain-Child-Tenant', child);
    return req.send({
      entityRef: { vertical: 'crm', id: 'customer-1' },
      predicate: 'city',
      object,
      validFrom: new Date().toISOString(),
      source: { vertical: 'crm' },
    });
  };

  const objects = async (tenant: string): Promise<string[]> =>
    f.app.get(SurrealService).withCompany(tenant, async (db) => {
      const [rows] = await db.query<[string[]]>('SELECT VALUE object FROM knowledge_fact');
      return ((rows as string[]) ?? []).sort();
    });

  it('each client company is its own tenant, invisible to the others and to the parent', async () => {
    expect((await writeFact('acme', 'Lisbon')).status).toBe(201);
    expect((await writeFact('beta', 'Porto')).status).toBe(201);
    expect((await writeFact(undefined, 'Faro')).status).toBe(201);

    expect(await objects(`${PARENT}__acme`)).toEqual(['Lisbon']);
    expect(await objects(`${PARENT}__beta`)).toEqual(['Porto']);
    expect(await objects(PARENT)).toEqual(['Faro']);
  });

  it('refuses a child id that tries to leave the namespace', async () => {
    const res = await writeFact('other__acme', 'Braga');
    expect(res.status).toBe(400);
  });

  it('the parent erases one child whole; the others stay', async () => {
    const res = await f.http.delete('/v1/tenants/children/acme').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ childId: `${PARENT}__acme`, erased: true });
    expect(await objects(`${PARENT}__acme`)).toEqual([]);
    expect(await objects(`${PARENT}__beta`)).toEqual(['Porto']);
    expect(await objects(PARENT)).toEqual(['Faro']);
  });

  it('a request already inside a child cannot erase anything', async () => {
    const res = await f.http
      .delete('/v1/tenants/children/beta')
      .set(auth())
      .set('X-Brain-Child-Tenant', 'beta');
    expect(res.status).toBe(403);
    expect(await objects(`${PARENT}__beta`)).toEqual(['Porto']);
  });
});
