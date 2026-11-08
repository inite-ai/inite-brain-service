import type { Surreal } from 'surrealdb';
import { ATLANTICA_DEMO_PACK } from '../src/demo/atlantica-pack';
import {
  applyDemoSeed,
  assertDemoTenant,
  entityRecordId,
  factRecordId,
  NotDemoTenantError,
  parseSeedArgs,
  validateDemoPack,
} from '../src/demo/demo-seed';
import { DEMO_ORG_ID } from '../src/demo/demo-tenant';

function recordingDb(): { db: Surreal; calls: Array<{ sql: string; vars: unknown }> } {
  const calls: Array<{ sql: string; vars: unknown }> = [];
  const db = {
    query: jest.fn((sql: string, vars: unknown) => {
      calls.push({ sql, vars });
      // createEdgeBetween reads the first row of the first result.
      return Promise.resolve([[{ id: 'knowledge_edge:x' }]]);
    }),
  } as unknown as Surreal;
  return { db, calls };
}

describe('demo seed', () => {
  it('refuses any tenant but the demo tenant', () => {
    expect(() => assertDemoTenant('co_acme')).toThrow(NotDemoTenantError);
    expect(() => assertDemoTenant('demo')).toThrow(NotDemoTenantError);
    expect(() => assertDemoTenant(undefined)).toThrow(NotDemoTenantError);
    expect(assertDemoTenant(DEMO_ORG_ID)).toBe(DEMO_ORG_ID);
  });

  it('refuses a non-demo tenant before touching the database', async () => {
    const { db, calls } = recordingDb();
    await expect(applyDemoSeed(db, 'co_acme')).rejects.toThrow(NotDemoTenantError);
    expect(calls).toHaveLength(0);
  });

  it('is a dry run unless both --apply and DEMO_SEED_WRITE=1 are given', () => {
    expect(parseSeedArgs([], {}).apply).toBe(false);
    expect(parseSeedArgs(['--apply'], {}).apply).toBe(false);
    expect(parseSeedArgs([], { DEMO_SEED_WRITE: '1' }).apply).toBe(false);
    expect(parseSeedArgs(['--apply'], { DEMO_SEED_WRITE: '1' }).apply).toBe(true);
    expect(parseSeedArgs([], {}).tenant).toBe(DEMO_ORG_ID);
    expect(parseSeedArgs(['--tenant', 'co_acme'], {}).tenant).toBe('co_acme');
    expect(parseSeedArgs(['--tenant=co_x'], {}).tenant).toBe('co_x');
  });

  it('the pack is whole', () => {
    expect(validateDemoPack(ATLANTICA_DEMO_PACK)).toEqual([]);
  });

  it('the pack is made up: no PII predicate, no outside link, no real mailbox', () => {
    const text = JSON.stringify(ATLANTICA_DEMO_PACK);
    expect(text).not.toMatch(/https?:\/\//);
    for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
      expect(m).toMatch(/@demo\.invalid$|@example\.com$/);
    }
    const pii = new Set(['email', 'phone', 'dob']);
    expect(ATLANTICA_DEMO_PACK.facts.filter((f) => pii.has(f.predicate))).toEqual([]);
  });

  it('writes fixed ids, no embedding, and supersedes the moved opening date', async () => {
    const { db, calls } = recordingDb();
    const summary = await applyDemoSeed(db, DEMO_ORG_ID);
    expect(summary).toMatchObject({
      tenant: DEMO_ORG_ID,
      entities: ATLANTICA_DEMO_PACK.entities.length,
      facts: ATLANTICA_DEMO_PACK.facts.length,
      edges: ATLANTICA_DEMO_PACK.edges.length,
    });
    const upserts = calls.filter((c) => c.sql.startsWith('UPSERT'));
    expect(upserts).toHaveLength(
      ATLANTICA_DEMO_PACK.entities.length + ATLANTICA_DEMO_PACK.facts.length,
    );
    for (const u of upserts) {
      const vars = u.vars as { id: unknown; content: Record<string, unknown> };
      expect(String(vars.id)).toMatch(/^knowledge_(entity|fact):demo_/);
      expect(vars.content).not.toHaveProperty('embedding');
    }
    const jan = upserts.find(
      (u) => String((u.vars as { id: unknown }).id) === factRecordId('opening_target_jan'),
    );
    const content = (jan?.vars as { content: Record<string, unknown> }).content;
    expect(content.status).toBe('superseded');
    expect(String(content.supersededBy)).toBe(factRecordId('opening_target_mar'));
    expect(calls.filter((c) => c.sql.includes('RELATE'))).toHaveLength(
      ATLANTICA_DEMO_PACK.edges.length,
    );
    expect(entityRecordId('ana')).toBe('knowledge_entity:demo_ana');
  });
});
