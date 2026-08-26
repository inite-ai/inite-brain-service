/**
 * Evidence plane e2e (PROVENANCE_RECURSIVE_CLOSURE, real SurrealDB):
 * the recursive support closure of GET /v1/facts/:id/provenance against
 * the REAL fences — (1) the root 404 on a cross-user read is unchanged,
 * (2) a fenced MEMBER of a tenant-global summary is a silent drop with
 * `filtered: true` (never an error), (3) the PII gate on closure
 * episodes follows brain:read_pii exactly like the one-hop path.
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('fact provenance closure (real SurrealDB)', () => {
  let f: AppFixture;
  let summaryId = '';
  let userAFactId = '';
  const m2mAuth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const userBAuth = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
  const noPiiAuth = () => ({ Authorization: `Bearer ${f.extraApiKeys[1]}` });

  beforeAll(async () => {
    process.env.FACTS_API_ENABLED = '1';
    process.env.PROVENANCE_RECURSIVE_CLOSURE = '1';
    f = await createApp({
      companyId: 'co_prov_closure_e2e',
      extraKeys: [
        // A user-B-bound read token (cross-user fences).
        { scopes: ['brain:read'], userId: 'user-b' },
        // An M2M read token WITHOUT brain:read_pii (PII gate).
        { scopes: ['brain:read'] },
      ],
    });

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [entRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT {
           type: 'customer', canonicalName: 'Closure Subject'
         }`,
      );
      const entityId = entRows[0]!.id;

      // Three grounding turns: tenant-global, user-A-scoped, PII-classed.
      await db.query(`INSERT INTO episode $rows`, {
        rows: [
          {
            kind: 'turn',
            conversationId: 'conv_closure',
            messageId: 'm1',
            speaker: 'user',
            text: 'global remark about the lease',
            occurredAt: new Date('2026-07-01T10:00:00Z'),
            source: {},
          },
          {
            kind: 'turn',
            conversationId: 'conv_closure',
            messageId: 'm2',
            speaker: 'user',
            text: 'user-a private remark',
            occurredAt: new Date('2026-07-02T10:00:00Z'),
            userId: 'user-a',
            source: {},
          },
          {
            kind: 'turn',
            conversationId: 'conv_closure',
            messageId: 'm3',
            speaker: 'user',
            text: 'my phone number is 555-0100',
            occurredAt: new Date('2026-07-03T10:00:00Z'),
            piiClass: ['contact'],
            source: {},
          },
        ],
      });
      const [epRows] = await db.query<[Array<{ id: unknown; messageId: string }>]>(
        // 3.x: the ORDER BY idiom must appear in the selection.
        `SELECT id, messageId, occurredAt FROM episode ORDER BY occurredAt ASC`,
      );
      const epId = (msg: string) => String(epRows.find((e) => e.messageId === msg)!.id);

      // Promotion-shaped members (status 'compacted', each stamped) —
      // m2's member is user-A's; m3's member cites the PII turn.
      const createFact = async (fields: Record<string, unknown>): Promise<string> => {
        const [rows] = await db.query<[Array<{ id: unknown }>]>(
          `CREATE knowledge_fact CONTENT $fields`,
          {
            fields: {
              entityId,
              confidence: 0.9,
              validFrom: new Date('2026-07-01T00:00:00Z'),
              ...fields,
            },
          },
        );
        return String(rows[0]!.id);
      };
      const member1 = await createFact({
        predicate: 'said',
        object: 'global remark about the lease',
        status: 'compacted',
        source: { kind: 'fact', episodeIds: [epId('m1')] },
      });
      const member2 = await createFact({
        predicate: 'said',
        object: 'user-a private remark',
        status: 'compacted',
        userId: 'user-a',
        source: { kind: 'fact', episodeIds: [epId('m2')] },
      });
      const member3 = await createFact({
        predicate: 'said',
        object: 'shared a phone number',
        status: 'compacted',
        source: { kind: 'fact', episodeIds: [epId('m3')] },
      });
      summaryId = await createFact({
        predicate: 'summary_said',
        object: 'Talked about the lease and shared contact details.',
        status: 'active',
        source: { kind: 'promotion' },
        // 3.x does not coerce string↔record — record-id params required.
        derivedFrom: [member1, member2, member3].map((id) => new StringRecordId(id)),
      });
      // A user-A-owned root for the cross-user 404.
      userAFactId = await createFact({
        predicate: 'preference',
        object: 'prefers morning viewings',
        status: 'active',
        userId: 'user-a',
        source: { kind: 'fact', episodeIds: [epId('m2')] },
      });
    });
  }, 120_000);

  afterAll(async () => {
    delete process.env.FACTS_API_ENABLED;
    delete process.env.PROVENANCE_RECURSIVE_CLOSURE;
    if (f) await f.close();
  });

  it("cross-user ROOT is still a 404 (user-B key on user-A's fact — closure changes nothing)", async () => {
    const res = await f.http
      .get(`/v1/facts/${encodeURIComponent(userAFactId)}/provenance`)
      .set(userBAuth());
    expect(res.status).toBe(404);
  });

  it('member fence is a SILENT drop: M2M sees the member episodes, user-B sees them dropped + filtered', async () => {
    // M2M with read_pii: full closure — all three members, all three turns.
    const m2m = await f.http
      .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
      .set(m2mAuth());
    expect(m2m.status).toBe(200);
    expect(m2m.body.episodes.map((e: { text: string }) => e.text)).toEqual([
      'global remark about the lease',
      'user-a private remark',
      'my phone number is 555-0100',
    ]);
    expect(m2m.body.derivedFacts).toHaveLength(3);
    expect(
      m2m.body.derivedFacts.every(
        (d: { status: string; depth: number }) => d.status === 'compacted' && d.depth === 1,
      ),
    ).toBe(true);
    expect(m2m.body.closure).toEqual({
      depth: 1,
      factCount: 3,
      truncated: false,
      filtered: false,
    });

    // User-B: the user-A member is silently dropped (filtered marker, no
    // error); the PII turn is fenced by the missing brain:read_pii.
    const userB = await f.http
      .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
      .set(userBAuth());
    expect(userB.status).toBe(200);
    expect(userB.body.episodes.map((e: { text: string }) => e.text)).toEqual([
      'global remark about the lease',
    ]);
    expect(userB.body.closure.filtered).toBe(true);
    expect(userB.body.closure.factCount).toBe(2); // member2 dropped
    expect(userB.body.derivedFacts).toHaveLength(2);
  });

  it('PII episode is invisible without brain:read_pii and served with it', async () => {
    const noPii = await f.http
      .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
      .set(noPiiAuth());
    expect(noPii.status).toBe(200);
    // M2M (no user fence) sees the user-A member's turn — only the
    // PII-classed turn is gone; the member row itself stays visible.
    expect(noPii.body.episodes.map((e: { text: string }) => e.text)).toEqual([
      'global remark about the lease',
      'user-a private remark',
    ]);
    expect(noPii.body.closure).toEqual({
      depth: 1,
      factCount: 3,
      truncated: false,
      filtered: false,
    });

    const withPii = await f.http
      .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
      .set(m2mAuth());
    expect(withPii.body.episodes).toHaveLength(3);
  });
});
