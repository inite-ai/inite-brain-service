/**
 * Scene entity links (Brain v2 PR3, SCENES_ENTITY_LINKS) — the resolution
 * matrix, over scripted doubles. No network, no Nest, no paid calls.
 *
 * Three layers, each pinned where it lives:
 *
 *  1. PURE selection (scene-entity-links.ts): which mentions are attempted
 *     (dedupe, cap, model order) and how resolved ids become a stable
 *     column value (dedupe + sort ⇒ idempotent re-runs).
 *
 *  2. THE RESOLVER (EntityUpsertService.resolveExistingByName): the
 *     resolve-only ladder — exact hit links, no hit drops, an AMBIGUOUS
 *     name links nothing, a merged-away entity is excluded, and the scope
 *     fence means a CROSS-USER candidate is never even a candidate. The
 *     load-bearing negative: the lookup issues no CREATE/UPDATE at all —
 *     a scene must never mint or mutate an entity.
 *
 *  3. THE ENRICHER LEG: flag off is byte-identical (the resolver is a
 *     THROWING stub and the SELECT / UPDATE are unchanged); flag on writes
 *     `entityIds` as record refs, drops what does not resolve, honours the
 *     cap, passes the #387 single-user scope through, and is idempotent
 *     across a re-run.
 */
import type { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import type { SurrealService } from '../src/db/surreal.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';
import { SceneEnricherService } from '../src/admin/scene-enricher.service';
import {
  SCENE_ENTITY_LINKS_MAX,
  selectSceneMentions,
  stableEntityIds,
} from '../src/admin/scene-entity-links';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';

// ── 1. the pure half ────────────────────────────────────────────────────

describe('selectSceneMentions', () => {
  it('trims, drops blanks and de-duplicates case-insensitively, first spelling wins', () => {
    expect(selectSceneMentions(['  Lisbon ', 'lisbon', '', '   ', 'Mika', 'LISBON'])).toEqual([
      'Lisbon',
      'Mika',
    ]);
  });

  it('keeps the model’s own order and truncates at the cap', () => {
    const many = Array.from({ length: SCENE_ENTITY_LINKS_MAX + 5 }, (_v, i) => `e${i}`);
    const picked = selectSceneMentions(many);
    expect(picked).toHaveLength(SCENE_ENTITY_LINKS_MAX);
    expect(picked[0]).toBe('e0');
    expect(picked).not.toContain(`e${SCENE_ENTITY_LINKS_MAX}`);
  });
});

describe('stableEntityIds', () => {
  it('is a function of the resolved SET, not of mention order', () => {
    const a = stableEntityIds(['knowledge_entity:z', 'knowledge_entity:a', 'knowledge_entity:z']);
    const b = stableEntityIds(['knowledge_entity:a', 'knowledge_entity:z']);
    expect(a).toEqual(['knowledge_entity:a', 'knowledge_entity:z']);
    expect(a).toEqual(b);
  });
});

// ── 2. the resolve-only ladder ──────────────────────────────────────────

interface ResolverCapture {
  queries: Array<{ sql: string; params: Record<string, unknown> | undefined }>;
}

/** Scripted Surreal double: `rows` answers every knowledge_entity probe. */
function resolverDb(rows: Array<{ id: string; canonicalName?: string }>): {
  db: Surreal;
  captured: ResolverCapture;
} {
  const captured: ResolverCapture = { queries: [] };
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      captured.queries.push({ sql, params });
      if (/^\s*(CREATE|UPDATE|INSERT|DELETE|RELATE)/i.test(sql.trim())) {
        throw new Error(`a resolve-only lookup must never write: ${sql}`);
      }
      return [rows];
    },
  } as unknown as Surreal;
  return { db, captured };
}

describe('EntityUpsertService.resolveExistingByName — resolve-only, never mint', () => {
  const svc = () => new EntityUpsertService();
  const SAVED = {
    article: process.env.INGEST_ARTICLE_NORMALIZATION,
    codeAlias: process.env.INGEST_CODE_ALIAS_RESOLUTION,
    scopeTags: process.env.SCOPE_TAGS_ENABLED,
  };
  afterEach(() => {
    for (const [k, v] of [
      ['INGEST_ARTICLE_NORMALIZATION', SAVED.article],
      ['INGEST_CODE_ALIAS_RESOLUTION', SAVED.codeAlias],
      ['SCOPE_TAGS_ENABLED', SAVED.scopeTags],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('an EXACT canonical/alias hit resolves, and the probe writes nothing', async () => {
    const { db, captured } = resolverDb([{ id: 'knowledge_entity:lisbon' }]);
    await expect(svc().resolveExistingByName(db, { name: 'Lisbon' })).resolves.toBe(
      'knowledge_entity:lisbon',
    );
    const probe = captured.queries[0]!;
    expect(probe.sql).toContain('canonicalNameLc = $name OR aliases CONTAINS $rawName');
    expect(probe.sql).toContain('mergedInto IS NONE');
    expect(probe.params).toMatchObject({ name: 'lisbon', rawName: 'Lisbon' });
    // Exactly one probe: the ladder stops at the first hit.
    expect(captured.queries).toHaveLength(1);
  });

  it('NO hit ⇒ null (the mention is dropped, never minted)', async () => {
    const { db } = resolverDb([]);
    await expect(svc().resolveExistingByName(db, { name: 'Nobody' })).resolves.toBeNull();
  });

  it('an AMBIGUOUS name links NOTHING (two candidates = no answer)', async () => {
    const { db } = resolverDb([{ id: 'knowledge_entity:a' }, { id: 'knowledge_entity:b' }]);
    await expect(svc().resolveExistingByName(db, { name: 'John Smith' })).resolves.toBeNull();
  });

  it('a blank mention never reaches the database', async () => {
    const { db, captured } = resolverDb([{ id: 'knowledge_entity:x' }]);
    await expect(svc().resolveExistingByName(db, { name: '   ' })).resolves.toBeNull();
    expect(captured.queries).toEqual([]);
  });

  it('UNSCOPED lookups see tenant-global entities ONLY (a personal one can never link)', async () => {
    const { db, captured } = resolverDb([]);
    await svc().resolveExistingByName(db, { name: 'Lisbon' });
    expect(captured.queries[0]!.sql).toContain('AND userId IS NONE');
    expect(captured.queries[0]!.params).not.toHaveProperty('scopeUserId');
  });

  it('a SCOPED lookup adds its OWN user and nobody else’s', async () => {
    const { db, captured } = resolverDb([]);
    await svc().resolveExistingByName(db, { name: 'Lisbon' }, { userId: 'u1' });
    const sql = captured.queries[0]!.sql;
    expect(sql).toContain('AND (userId IS NONE OR userId = $scopeUserId)');
    // A third user's rows are excluded by the SAME clause — the fence is
    // an equality on the caller's key, never an "any user" opening.
    expect(sql).not.toContain('userId != NONE');
    expect(captured.queries[0]!.params).toMatchObject({ scopeUserId: 'u1' });
  });

  it('the 0093 scope-tag fence ANDs alongside when SCOPE_TAGS_ENABLED is on', async () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    const { db, captured } = resolverDb([]);
    await svc().resolveExistingByName(db, { name: 'Lisbon' }, { userId: 'u1' });
    expect(captured.queries[0]!.sql).toContain('$entityScopeTag');
    expect(captured.queries[0]!.params).toHaveProperty('entityScopeTag');
  });

  it('falls through to the article variants only under INGEST_ARTICLE_NORMALIZATION', async () => {
    const { db, captured } = resolverDb([]);
    await svc().resolveExistingByName(db, { name: 'the office lease' });
    expect(captured.queries).toHaveLength(1); // flag off ⇒ no second probe

    process.env.INGEST_ARTICLE_NORMALIZATION = '1';
    const withFlag = resolverDb([]);
    await svc().resolveExistingByName(withFlag.db, { name: 'the office lease' });
    expect(withFlag.captured.queries).toHaveLength(2);
    expect(withFlag.captured.queries[1]!.sql).toContain('canonicalNameLc IN $variants');
    expect(withFlag.captured.queries[1]!.params!.variants).toContain('office lease');
  });

  it('falls through to the code path↔symbol convention only under its own flag', async () => {
    // The exact probe must MISS for the ladder to reach step 3, so the
    // double answers miss-then-hit.
    const pages: Array<Array<{ id: string }>> = [[], [{ id: 'knowledge_entity:dispatcher' }]];
    const captured: ResolverCapture = { queries: [] };
    let call = 0;
    const scripted = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        captured.queries.push({ sql, params });
        return [pages[call++] ?? []];
      },
    } as unknown as Surreal;

    // Flag off: the ladder stops after the exact miss.
    delete process.env.INGEST_CODE_ALIAS_RESOLUTION;
    await expect(
      svc().resolveExistingByName(scripted, { name: 'src/gateway/webhook-dispatcher.ts' }),
    ).resolves.toBeNull();
    expect(captured.queries).toHaveLength(1);

    process.env.INGEST_CODE_ALIAS_RESOLUTION = '1';
    call = 0;
    captured.queries.length = 0;
    await expect(
      svc().resolveExistingByName(scripted, { name: 'src/gateway/webhook-dispatcher.ts' }),
    ).resolves.toBe('knowledge_entity:dispatcher');
    const last = captured.queries[captured.queries.length - 1]!;
    expect(last.params).toMatchObject({ sym: 'webhookdispatcher' });
    // Still read-only: the ingest path stamps the new surface into the
    // reused entity's aliases; a derived backlink must not mutate it.
    expect(captured.queries.every((q) => /^\s*SELECT/i.test(q.sql))).toBe(true);
  });

  it('never throws — a lookup failure degrades to null', async () => {
    const db = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as Surreal;
    const service = svc();
    jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    await expect(service.resolveExistingByName(db, { name: 'Lisbon' })).resolves.toBeNull();
  });
});

// ── 3. the enricher leg ─────────────────────────────────────────────────

const WELL_FORMED = {
  gist: 'Mika planned the Lisbon trip and booked the morning flight.',
  memoryValue: {
    novelty: 0.8,
    contradiction: 0,
    stateChange: 0.6,
    identity: 0.2,
    explicitness: 0.9,
    estimatedUtility: 0.7,
  },
  stateDeltas: [{ subject: 'mika', field: 'trip.flight', from: '', to: 'booked' }],
  unexpectedDetails: [],
  entityMentions: ['Mika', 'Lisbon', 'Unknown Place'],
};

interface EnricherCapture {
  updates: Array<{ sql: string; params: Record<string, unknown> }>;
  queries: string[];
  resolved: Array<{ name: string; userId: string | undefined }>;
}

function buildEnricher(opts: {
  /** mention (lowercased) → entity id, or absent for "no hit". */
  hits?: Record<string, string>;
  /** Scope stamps on the single fake scene (default: single-user u1). */
  scope?: Record<string, unknown>;
  /** Reply override (defaults to WELL_FORMED). */
  mentions?: string[];
  /** Wire NO resolver at all (the partial-wiring degrade). */
  unwired?: boolean;
  /** The resolver must never be touched (the flag-off pin). */
  throwing?: boolean;
}): { svc: SceneEnricherService; captured: EnricherCapture } {
  const captured: EnricherCapture = { updates: [], queries: [], resolved: [] };
  const fakeDb = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      captured.queries.push(sql);
      if (sql.includes('UPDATE $scene')) {
        captured.updates.push({ sql, params: params ?? {} });
        return [[]];
      }
      if (sql.includes('FROM memory_episode_member')) return [[{ out: 'episode:e1', ord: 0 }]];
      if (sql.includes('FROM memory_episode')) {
        return [
          [
            {
              id: 'memory_episode:s1',
              conversationIds: ['conv'],
              ...(opts.scope ?? { userId: 'u1', userIds: ['u1'] }),
            },
          ],
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const entities = opts.throwing
    ? ({
        resolveExistingByName: async () => {
          throw new Error('entity resolution must not run with SCENES_ENTITY_LINKS off');
        },
      } as unknown as EntityUpsertService)
    : ({
        resolveExistingByName: async (
          _db: Surreal,
          e: { name: string },
          o: { userId?: string | undefined } = {},
        ) => {
          captured.resolved.push({ name: e.name, userId: o.userId });
          return opts.hits?.[e.name.toLowerCase()] ?? null;
        },
      } as unknown as EntityUpsertService);
  const svc = new SceneEnricherService(
    {
      withCompany: (_c: string, fn: (db: unknown) => Promise<unknown>) => fn(fakeDb),
    } as unknown as SurrealService,
    { get: (_k: string, d?: unknown) => d } as unknown as ConfigService,
    {
      conversationTurnsRaw: async () => [
        {
          id: 'episode:e1',
          speaker: 'mika',
          text: 'I booked the morning flight to Lisbon.',
          occurredAt: '2026-02-01T10:00:00.000Z',
        },
      ],
    } as unknown as EpisodeReadStoreService,
    {
      resolve: () => ({
        version: SEGMENTER_VERSION,
        cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
      }),
    } as unknown as SceneVersionService,
    ...(opts.unwired ? [] : [entities]),
  );
  (svc as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...WELL_FORMED,
                  ...(opts.mentions ? { entityMentions: opts.mentions } : {}),
                }),
              },
            },
          ],
        }),
      },
    },
  };
  return { svc, captured };
}

const linkIds = (c: EnricherCapture): string[] =>
  ((c.updates[0]!.params.entityIds as StringRecordId[] | undefined) ?? []).map((r) => String(r));

describe('SceneEnricherService — entity links OFF (the byte-identical pin)', () => {
  const saved = {
    enrich: process.env.SCENES_LLM_ENRICHMENT,
    links: process.env.SCENES_ENTITY_LINKS,
  };
  beforeAll(() => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    delete process.env.SCENES_ENTITY_LINKS;
  });
  afterAll(() => {
    for (const [k, v] of [
      ['SCENES_LLM_ENRICHMENT', saved.enrich],
      ['SCENES_ENTITY_LINKS', saved.links],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the resolver is NEVER called and no entityIds clause is emitted', async () => {
    const { svc, captured } = buildEnricher({ throwing: true });
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 1, failed: 0, skipped: 0 });
    const { sql, params } = captured.updates[0]!;
    expect(sql).not.toContain('entityIds');
    expect(params.entityIds).toBeUndefined();
    // The scene SELECT projection is byte-identical too (no scope columns
    // are needed when neither the baseline nor the links leg is on).
    const select = captured.queries.find((q) => q.includes('FROM memory_episode\n'))!;
    expect(select).toBe(
      `SELECT id, conversationIds, enrichmentVersion FROM memory_episode\n` +
        `          WHERE segmenterVersion = $v`,
    );
  });
});

describe('SceneEnricherService — entity links ON (the resolution matrix)', () => {
  const saved = {
    enrich: process.env.SCENES_LLM_ENRICHMENT,
    links: process.env.SCENES_ENTITY_LINKS,
  };
  beforeAll(() => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    process.env.SCENES_ENTITY_LINKS = '1';
  });
  afterAll(() => {
    for (const [k, v] of [
      ['SCENES_LLM_ENRICHMENT', saved.enrich],
      ['SCENES_ENTITY_LINKS', saved.links],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const HITS = { mika: 'knowledge_entity:mika', lisbon: 'knowledge_entity:lisbon' };

  it('resolved mentions become RECORD refs; unresolved ones are dropped', async () => {
    const { svc, captured } = buildEnricher({ hits: HITS });
    await svc.enrich('co_test');
    const { sql, params } = captured.updates[0]!;
    expect(sql).toContain('entityIds = $entityIds');
    // Sorted set — never the model's mention order.
    expect(linkIds(captured)).toEqual(['knowledge_entity:lisbon', 'knowledge_entity:mika']);
    // Record refs, not strings — the whole point of the 0106 contract.
    for (const ref of params.entityIds as StringRecordId[]) {
      expect(ref).toBeInstanceOf(StringRecordId);
    }
    // "Unknown Place" was attempted and simply did not resolve.
    expect(captured.resolved.map((r) => r.name)).toEqual(['Mika', 'Lisbon', 'Unknown Place']);
  });

  it('nothing resolves ⇒ an explicit empty set, still written (stable across re-runs)', async () => {
    const { svc, captured } = buildEnricher({ hits: {} });
    await svc.enrich('co_test');
    expect(captured.updates[0]!.sql).toContain('entityIds = $entityIds');
    expect(linkIds(captured)).toEqual([]);
  });

  it('is IDEMPOTENT: a second run over the same corpus writes the identical value', async () => {
    const first = buildEnricher({ hits: HITS });
    await first.svc.enrich('co_test');
    const second = buildEnricher({ hits: HITS, mentions: ['Lisbon', 'Mika', 'lisbon'] });
    await second.svc.enrich('co_test');
    expect(linkIds(second.captured)).toEqual(linkIds(first.captured));
  });

  it('honours the per-scene cap — at most SCENE_ENTITY_LINKS_MAX lookups', async () => {
    const mentions = Array.from({ length: SCENE_ENTITY_LINKS_MAX + 8 }, (_v, i) => `Thing ${i}`);
    const { svc, captured } = buildEnricher({ hits: {}, mentions });
    await svc.enrich('co_test');
    expect(captured.resolved).toHaveLength(SCENE_ENTITY_LINKS_MAX);
  });

  it('a SINGLE-USER scene resolves under its own scope key (#387)', async () => {
    const { svc, captured } = buildEnricher({ hits: HITS });
    await svc.enrich('co_test');
    expect(captured.resolved.every((r) => r.userId === 'u1')).toBe(true);
  });

  it.each([
    ['mixed-user', { userId: 'u1', userIds: ['u1', 'u2'] }],
    ['tenant-global', { userIds: [] }],
    ['legacy (no userIds)', { userId: 'u1' }],
  ])(
    'a %s scene resolves TENANT-GLOBAL only — a foreign user’s entity can never link',
    async (_label, scope) => {
      const { svc, captured } = buildEnricher({ hits: HITS, scope });
      await svc.enrich('co_test');
      // undefined scope key ⇒ the resolver's `userId IS NONE` branch.
      expect(captured.resolved.every((r) => r.userId === undefined)).toBe(true);
    },
  );

  it('projects the scope columns the fence needs', async () => {
    const { svc, captured } = buildEnricher({ hits: HITS });
    await svc.enrich('co_test');
    const select = captured.queries.find((q) => q.includes('FROM memory_episode\n'))!;
    expect(select).toContain('userId, userIds');
  });

  it('no resolver wired ⇒ an empty link set, and the enrichment still lands', async () => {
    const { svc, captured } = buildEnricher({ unwired: true });
    const result = await svc.enrich('co_test');
    expect(result.enriched).toBe(1);
    expect(linkIds(captured)).toEqual([]);
  });

  it('a resolver failure drops that mention and the write still lands', async () => {
    const { svc, captured } = buildEnricher({ throwing: true });
    jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await svc.enrich('co_test');
    expect(result.enriched).toBe(1);
    expect(linkIds(captured)).toEqual([]);
  });
});
