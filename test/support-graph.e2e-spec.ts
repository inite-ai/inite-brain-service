/**
 * Typed support graph e2e (Drift-5, real SurrealDB): the 0116
 * memory_support table end-to-end —
 *   (1) INSERT RELATION IGNORE is replay-idempotent on the REAL pinned
 *       server (the scene-backlink writer runs twice, the direct
 *       derived_from insert replays twice — UNIQUE(in, out, kind)
 *       dedupes both);
 *   (2) the conflict resolver records the COMPETING mutual pair;
 *   (3) GET /v1/facts/:id/provenance with the read flag on serves
 *       supportEdges, and a root with typed edges but an EMPTY
 *       derivedFrom array walks;
 *   (4) read flag off → NO supportEdges key (byte-identical response);
 *   (5) user-forget erases every edge touching the user's facts —
 *       with the write flag OFF at forget time (GDPR runs regardless).
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import { FactResolverService } from '../src/ingest/fact-resolver.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { UserForgetService } from '../src/entities/user-forget.service';

const FLAG_KEYS = [
  'FACTS_API_ENABLED',
  'PROVENANCE_RECURSIVE_CLOSURE',
  'PROVENANCE_SUPPORT_EDGES',
  'PROVENANCE_SUPPORT_GRAPH_READ',
  'SCENES_FACT_BACKLINK',
] as const;
const savedEnv = new Map<string, string | undefined>();

describe('typed support graph (real SurrealDB)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let entityId = '';
  let backlinkFactId = '';
  let sceneId = '';
  let standingFactId = '';
  let newFactId = '';
  let summaryId = '';
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const countEdges = async (where: string, params: Record<string, unknown> = {}) =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_support ${where} GROUP ALL`,
        params,
      );
      return rows?.[0]?.n ?? 0;
    });

  beforeAll(async () => {
    for (const k of FLAG_KEYS) savedEnv.set(k, process.env[k]);
    process.env.FACTS_API_ENABLED = '1';
    process.env.PROVENANCE_RECURSIVE_CLOSURE = '1';
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    process.env.PROVENANCE_SUPPORT_GRAPH_READ = '1';
    process.env.SCENES_FACT_BACKLINK = '1';
    f = await createApp({ companyId: 'co_support_graph_e2e' });
    surreal = f.app.get(SurrealService);

    await surreal.withCompany(f.companyId, async (db) => {
      const [entRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT { type: 'customer', canonicalName: 'Support Graph Subject' }`,
      );
      entityId = String(entRows[0]!.id);

      // Two verbatim turns + one scene over them (composer-shaped rows).
      const [epRows] = await db.query<[Array<{ id: unknown }>]>(`INSERT INTO episode $rows`, {
        rows: [
          {
            kind: 'turn',
            conversationId: 'conv_sg',
            messageId: 'sg1',
            speaker: 'user',
            text: 'the lease was renewed in March',
            occurredAt: new Date('2026-07-01T10:00:00Z'),
            source: {},
          },
          {
            kind: 'turn',
            conversationId: 'conv_sg',
            messageId: 'sg2',
            speaker: 'assistant',
            text: 'noted — renewal recorded',
            occurredAt: new Date('2026-07-01T10:01:00Z'),
            source: {},
          },
        ],
      });
      const episodeRefs = (epRows ?? []).map((r) => r.id);
      const episodeIds = episodeRefs.map(String);

      const [sceneRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE memory_episode CONTENT $scene`,
        {
          scene: {
            sceneLabel: 'lease renewal',
            conversationIds: ['conv_sg'],
            occurredFrom: new Date('2026-07-01T10:00:00Z'),
            occurredTo: new Date('2026-07-01T10:01:00Z'),
            gist: 'user: the lease was renewed in March',
            confidence: 0.9,
            segmenterVersion: SEGMENTER_VERSION,
            generation: 'gen-e2e',
            source: {},
          },
        },
      );
      sceneId = String(sceneRows[0]!.id);
      await db.query(`INSERT RELATION INTO memory_episode_member $rows`, {
        rows: episodeRefs.map((out, ord) => ({
          in: sceneRows[0]!.id,
          out,
          role: 'core',
          ord,
          relevance: 1,
          segmenterVersion: SEGMENTER_VERSION,
        })),
      });

      // A grounded fact inside the scene's conversation — the backlink
      // writer stamps it AND (flag on) emits the supported_by edge.
      const [factRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_fact CONTENT $fact`,
        {
          fact: {
            entityId: entRows[0]!.id,
            predicate: 'said',
            object: 'the lease was renewed in March',
            confidence: 0.9,
            validFrom: new Date('2026-07-01T00:00:00Z'),
            status: 'active',
            source: { kind: 'fact', conversationId: 'conv_sg', episodeIds: [episodeIds[0]] },
          },
        },
      );
      backlinkFactId = String(factRows[0]!.id);
    });
  });

  afterAll(async () => {
    for (const k of FLAG_KEYS) {
      const v = savedEnv.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await f.close();
  });

  it('scene backlink emits supported_by edges; a re-run inserts NOTHING new (IGNORE proven)', async () => {
    const backlink = f.app.get(SceneBacklinkService);
    const first = await backlink.run(f.companyId);
    expect(first.factsLinked).toBe(1);
    const afterFirst = await countEdges(`WHERE kind = 'supported_by'`);
    expect(afterFirst).toBe(1);

    // Replay — same scene ids, same fact: INSERT RELATION IGNORE over
    // UNIQUE(in, out, kind) must dedupe on the REAL pinned server.
    await backlink.run(f.companyId);
    expect(await countEdges(`WHERE kind = 'supported_by'`)).toBe(1);

    const rows = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<[Array<{ in: unknown; out: unknown; writer: string }>]>(
        `SELECT in, out, writer, writerVersion FROM memory_support WHERE kind = 'supported_by'`,
      );
      return r ?? [];
    });
    expect(String(rows[0]!.in)).toBe(backlinkFactId);
    expect(String(rows[0]!.out)).toBe(sceneId);
    expect(rows[0]!.writer).toBe('scene_backlink');
  });

  it('a COMPETING resolver verdict records the mutual contradicted_by pair', async () => {
    // single_active ALWAYS supersedes (the V9 slot doctrine — see
    // 0085's `$supersede`), so a genuine standoff needs a `bitemporal`
    // predicate: overlapping validity + cosine-similar values + a score
    // margin below margin_for_supersede ⇒ COMPETING, deterministically.
    // No CORE seed is bitemporal — register a tenant predicate.
    const registry = f.app.get(PredicateRegistryService);
    await registry.create(f.companyId, {
      predicateId: 'observed_state',
      semantics: 'bitemporal',
      piiClass: 'none',
    });
    registry.invalidate(f.companyId);

    const resolver = f.app.get(FactResolverService);
    const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    const base = {
      companyId: f.companyId,
      entityId,
      predicate: 'observed_state',
      confidence: 0.9,
      validFrom: new Date('2026-07-02T00:00:00Z'),
      source: {},
      precomputedEmbedding: embedding,
      userId: 'user-gone',
    };
    const first = await surreal.withCompany(f.companyId, (db) =>
      resolver.resolve(db, { ...base, object: 'gold tier' }),
    );
    expect(first.result.outcome).toBe('INSERTED');
    standingFactId = String(first.result.factId);

    // Identical embedding (similarity 1 ≥ threshold), overlapping
    // open-ended validity, same confidence/trust/authority and
    // near-equal recency ⇒ score margin ≈ 0 < margin_for_supersede ⇒
    // COMPETING.
    const second = await surreal.withCompany(f.companyId, (db) =>
      resolver.resolve(db, { ...base, object: 'platinum tier' }),
    );
    expect(second.result.outcome).toBe('COMPETING');
    newFactId = String(second.result.factId);

    const pair = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<[Array<{ in: unknown; out: unknown }>]>(
        `SELECT in, out FROM memory_support WHERE kind = 'contradicted_by'`,
      );
      return (r ?? []).map((e) => [String(e.in), String(e.out)]).sort();
    });
    expect(pair).toEqual(
      [
        [standingFactId, newFactId],
        [newFactId, standingFactId],
      ].sort(),
    );
  });

  it('provenance serves supportEdges; a root with EMPTY derivedFrom walks via typed edges', async () => {
    // A summary WITHOUT a derivedFrom array — only the typed edge
    // carries the derivation. Insert the edge TWICE: the replay is the
    // direct db-level INSERT RELATION IGNORE idempotency proof.
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(`CREATE knowledge_fact CONTENT $f`, {
        f: {
          // Record-id param — 3.x does not coerce string↔record.
          entityId: new StringRecordId(entityId),
          predicate: 'summary_said',
          object: 'Lease renewal summarized.',
          confidence: 0.9,
          validFrom: new Date('2026-07-03T00:00:00Z'),
          status: 'active',
          source: { kind: 'promotion' },
        },
      });
      summaryId = String(rows[0]!.id);
      for (let i = 0; i < 2; i++) {
        await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
          rows: [
            {
              in: rows[0]!.id,
              out: new StringRecordId(backlinkFactId),
              kind: 'derived_from',
              writer: 'promotion_runner',
            },
          ],
        });
      }
    });
    expect(await countEdges(`WHERE kind = 'derived_from'`)).toBe(1);

    const res = await f.http
      .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
      .set(auth());
    expect(res.status).toBe(200);
    // The edge-discovered child (depth 1) — derivedFrom array is EMPTY.
    expect(res.body.derivedFacts).toEqual([
      { factId: backlinkFactId, predicate: 'said', depth: 1, status: 'active' },
    ]);
    // Crossed edges: the summary's derived_from + the member's
    // supported_by (backlink test above).
    expect(res.body.supportEdges).toEqual(
      expect.arrayContaining([
        { kind: 'derived_from', from: summaryId, to: backlinkFactId },
        { kind: 'supported_by', from: backlinkFactId, to: sceneId },
      ]),
    );
    // Grounding harvested THROUGH the edge-discovered member.
    expect(res.body.episodes.map((e: { text: string }) => e.text)).toEqual([
      'the lease was renewed in March',
    ]);
  });

  it('read flag OFF: the provenance response has NO supportEdges key (byte-identical)', async () => {
    process.env.PROVENANCE_SUPPORT_GRAPH_READ = '0';
    try {
      const res = await f.http
        .get(`/v1/facts/${encodeURIComponent(summaryId)}/provenance`)
        .set(auth());
      expect(res.status).toBe(200);
      // Root has an EMPTY derivedFrom array ⇒ without the read flag the
      // one-hop path serves — no closure fields, no supportEdges.
      expect(res.body).not.toHaveProperty('supportEdges');
      expect(res.body).not.toHaveProperty('derivedFacts');
    } finally {
      process.env.PROVENANCE_SUPPORT_GRAPH_READ = '1';
    }
  });

  it('user-forget erases the user facts’ edges with the write flag OFF (GDPR runs regardless)', async () => {
    // Fail fast on a cascade from the resolver test — an empty record
    // id must never reach a query param.
    expect(standingFactId).not.toBe('');
    expect(newFactId).not.toBe('');
    process.env.PROVENANCE_SUPPORT_EDGES = '0';
    try {
      await f.app.get(UserForgetService).forgetUser(f.companyId, 'user-gone');
    } finally {
      process.env.PROVENANCE_SUPPORT_EDGES = '1';
    }
    expect(
      await countEdges(`WHERE in INSIDE $subjects OR out INSIDE $subjects`, {
        subjects: [standingFactId, newFactId].map((id) => new StringRecordId(id)),
      }),
    ).toBe(0);
    // The unrelated tenant-global edges survive.
    expect(await countEdges(`WHERE kind = 'supported_by'`)).toBe(1);
    expect(await countEdges(`WHERE kind = 'derived_from'`)).toBe(1);
  });
});
