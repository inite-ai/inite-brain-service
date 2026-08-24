import { NotFoundException } from '@nestjs/common';
import { FactsController } from '../src/facts/facts.controller';
import { FactsService } from '../src/facts/facts.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { SurrealService } from '../src/db/surreal.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { AuthenticatedRequest, BrainScope } from '../src/auth/api-key.types';
import type { RetractFactDto } from '../src/facts/dto/retract.dto';

/**
 * Fact read + provenance API ("show me why I remember this").
 *
 * The stub keeps per-tenant row sets and answers the two SQL shapes the
 * surface issues — the fact fetch (type::record) and the episode byIds
 * read. Episode PII/user fences are applied the way the REAL
 * EpisodeReadStoreService SQL would (the stub inspects the gate strings
 * the service composed), so these tests pin both the fact-level fences
 * (in FactsService) and the parameters handed to the shared episode
 * read port.
 */

interface Recorded {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

type Row = Record<string, unknown>;

const ridOf = (id: unknown): string => String((id as { rid?: unknown })?.rid ?? id);

function makeStack(opts: {
  factsByCompany: Record<string, Row[]>;
  episodesByCompany?: Record<string, Row[]>;
  policy?: Record<string, { requiresScope?: string; piiClass: string }>;
}): { svc: FactsService; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const dbFor = (companyId: string) => ({
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes("type::record('knowledge_fact'")) {
        const rows = (opts.factsByCompany[companyId] ?? []).filter(
          (f) => String(f.id) === `knowledge_fact:${String(params?.rid)}`,
        );
        return [rows];
      }
      if (sql.includes('FROM episode')) {
        const wanted = ((params?.ids as unknown[]) ?? []).map(ridOf);
        let rows = (opts.episodesByCompany?.[companyId] ?? []).filter((e) =>
          wanted.includes(String(e.id)),
        );
        if (sql.includes('piiClass IS NONE')) {
          rows = rows.filter((e) => e.piiClass === undefined);
        }
        if (sql.includes('userId = $scopeUserId')) {
          rows = rows.filter((e) => e.userId === undefined || e.userId === params?.scopeUserId);
        } else {
          rows = rows.filter((e) => e.userId === undefined);
        }
        return [rows];
      }
      return [[]];
    },
  });
  const surreal = {
    withScopedCompany: async (
      companyId: string,
      _scopes: readonly string[],
      fn: (db: unknown) => Promise<unknown>,
    ) => fn(dbFor(companyId)),
    withCompany: async (companyId: string, fn: (db: unknown) => Promise<unknown>) =>
      fn(dbFor(companyId)),
  } as unknown as SurrealService;
  const episodes = new EpisodeReadStoreService(surreal);
  const registry = opts.policy
    ? ({
        rowPolicyLookup: async () => (p: string) => opts.policy?.[p] ?? { piiClass: 'none' },
      } as unknown as PredicateRegistryService)
    : undefined;
  return {
    svc: new FactsService(surreal, episodes, undefined, registry),
    queries,
  };
}

const READ = ['brain:read'] as BrainScope[];
const READ_PII = ['brain:read', 'brain:read_pii'] as BrainScope[];

const LONG_TEXT = 'On the trip we talked about routes for hours. '.repeat(20); // ~920 chars

const FACT_GLOBAL: Row = {
  id: 'knowledge_fact:f1',
  predicate: 'preference',
  object: 'likes hiking in the mountains',
  confidence: 0.92,
  validFrom: '2026-08-01T00:00:00.000Z',
  status: 'active',
  derivedVersion: 'wd-v3s',
  source: {
    kind: 'fact',
    vertical: 'dialogue',
    recorder: 'session-deriver-v1',
    conversationId: 'conv-1',
    episodeIds: ['episode:e2', 'episode:e1'],
  },
};

const EPISODES: Row[] = [
  {
    id: 'episode:e1',
    conversationId: 'conv-1',
    speaker: 'Caroline',
    text: 'I love hiking, we should plan a trip!',
    occurredAt: '2026-07-01T10:00:00.000Z',
  },
  {
    id: 'episode:e2',
    conversationId: 'conv-1',
    speaker: 'Melanie',
    text: LONG_TEXT,
    occurredAt: '2026-07-02T10:00:00.000Z',
  },
];

describe('GET /v1/facts/:id — fact read', () => {
  it('happy path: serves the fact with its source attribution', async () => {
    const { svc } = makeStack({ factsByCompany: { co_a: [FACT_GLOBAL] } });
    const res = await svc.getFact({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(res).toEqual({
      factId: 'knowledge_fact:f1',
      aspect: 'preference',
      statement: 'likes hiking in the mountains',
      confidence: 0.92,
      validFrom: '2026-08-01T00:00:00.000Z',
      kind: 'fact',
      vertical: 'dialogue',
      recorder: 'session-deriver-v1',
      conversationId: 'conv-1',
      retracted: false,
      derivedVersion: 'wd-v3s',
    });
  });

  it('a retracted fact still resolves, flagged retracted: true', async () => {
    const { svc } = makeStack({
      factsByCompany: {
        co_a: [
          {
            ...FACT_GLOBAL,
            status: 'retracted',
            retractedAt: '2026-08-10T00:00:00.000Z',
          },
        ],
      },
    });
    const res = await svc.getFact({
      companyId: 'co_a',
      factId: 'knowledge_fact:f1',
      scopes: READ,
    });
    expect(res.retracted).toBe(true);
  });

  it('missing fact → 404', async () => {
    const { svc } = makeStack({ factsByCompany: { co_a: [FACT_GLOBAL] } });
    await expect(svc.getFact({ companyId: 'co_a', factId: 'nope', scopes: READ })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("another tenant's fact id → 404 (tenant fence)", async () => {
    const { svc } = makeStack({ factsByCompany: { co_a: [FACT_GLOBAL] } });
    await expect(svc.getFact({ companyId: 'co_b', factId: 'f1', scopes: READ })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('user scope (0055) on the fact read', () => {
  const USER_FACT: Row = { ...FACT_GLOBAL, userId: 'u2' };

  it("user-bound token: another user's fact → 404, not 403", async () => {
    const { svc } = makeStack({ factsByCompany: { co_a: [USER_FACT] } });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u1' }, async () => {
      await expect(svc.getFact({ companyId: 'co_a', factId: 'f1', scopes: READ })).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        svc.getProvenance({ companyId: 'co_a', factId: 'f1', scopes: READ }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('user-bound token: OWN user-scoped fact and tenant-global facts resolve', async () => {
    const { svc } = makeStack({
      factsByCompany: {
        co_a: [USER_FACT, { ...FACT_GLOBAL, id: 'knowledge_fact:f2' }],
      },
    });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u2' }, async () => {
      const own = await svc.getFact({
        companyId: 'co_a',
        factId: 'f1',
        scopes: READ,
      });
      expect(own.userId).toBe('u2');
      const global = await svc.getFact({
        companyId: 'co_a',
        factId: 'f2',
        scopes: READ,
      });
      expect(global.userId).toBeUndefined();
    });
  });

  it("M2M (no user-bound token) reads a user-scoped fact, and the episode fetch is keyed to the FACT's user", async () => {
    const { svc, queries } = makeStack({
      factsByCompany: { co_a: [USER_FACT] },
      episodesByCompany: {
        co_a: [
          { ...EPISODES[0], userId: 'u2' },
          { ...EPISODES[1], userId: 'u2' },
        ],
      },
    });
    const fact = await svc.getFact({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(fact.userId).toBe('u2');
    const prov = await svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(prov.episodes.map((e) => e.episodeId)).toEqual(['episode:e1', 'episode:e2']);
    const episodeQuery = queries.find((q) => q.sql.includes('FROM episode'));
    expect(episodeQuery?.sql).toContain('(userId IS NONE OR userId = $scopeUserId)');
    expect(episodeQuery?.params?.scopeUserId).toBe('u2');
  });
});

describe('GET /v1/facts/:id/provenance — grounding episodes', () => {
  it('happy path: chronological grounding turns, text capped at 600 chars', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [FACT_GLOBAL] },
      episodesByCompany: { co_a: EPISODES },
    });
    const res = await svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(res.factId).toBe('knowledge_fact:f1');
    // source.episodeIds order is [e2, e1]; the response is chronological.
    expect(res.episodes.map((e) => e.episodeId)).toEqual(['episode:e1', 'episode:e2']);
    expect(res.episodes[0]).toEqual({
      episodeId: 'episode:e1',
      conversationId: 'conv-1',
      speaker: 'Caroline',
      occurredAt: '2026-07-01T10:00:00.000Z',
      text: 'I love hiking, we should plan a trip!',
    });
    expect(res.episodes[1]!.text.length).toBe(600);
    expect(res.episodes[1]!.text.endsWith('…')).toBe(true);
  });

  it('G3: a fact with source.charSpans serves span + textTruncated per episode', async () => {
    const fact: Row = {
      ...FACT_GLOBAL,
      source: {
        ...(FACT_GLOBAL.source as Row),
        charSpans: [
          {
            // 'I love hiking, we should plan a trip!'
            episodeId: 'episode:e1',
            start: 7,
            end: 13,
            exact: 'hiking',
            prefix: 'I love ',
            suffix: ', we should plan a trip!',
          },
          {
            // LONG_TEXT (~920 chars) — offsets past the 600-char cap.
            episodeId: 'episode:e2',
            start: 700,
            end: 706,
            exact: 'routes',
            prefix: 'talked about ',
            suffix: ' for hours',
          },
          // Malformed entry (FLEXIBLE source): ignored, never served.
          { episodeId: 'episode:e1', exact: 'hiking' },
        ],
      },
    };
    const { svc } = makeStack({
      factsByCompany: { co_a: [fact] },
      episodesByCompany: { co_a: EPISODES },
    });
    const res = await svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    // Wire span is {start, end, exact} only — prefix/suffix stay stored.
    expect(res.episodes[0]!.span).toEqual({ start: 7, end: 13, exact: 'hiking' });
    expect(res.episodes[0]!.textTruncated).toBe(false);
    // Truncated episode: offsets reference the FULL stored text, and
    // textTruncated says so.
    expect(res.episodes[1]!.span).toEqual({
      start: 700,
      end: 706,
      exact: 'routes',
    });
    expect(res.episodes[1]!.textTruncated).toBe(true);
    expect(res.episodes[1]!.text.length).toBe(600);
  });

  it('G3: a fact without charSpans keeps the pre-span episode shape', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [FACT_GLOBAL] },
      episodesByCompany: { co_a: EPISODES },
    });
    const res = await svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    for (const ep of res.episodes) {
      expect(ep).not.toHaveProperty('span');
      expect(ep).not.toHaveProperty('textTruncated');
    }
  });

  it('a fact with no grounding stamp serves an empty episode list', async () => {
    const { svc } = makeStack({
      factsByCompany: {
        co_a: [{ ...FACT_GLOBAL, source: { vertical: 'dialogue' } }],
      },
    });
    const res = await svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(res.episodes).toEqual([]);
  });

  it('PII-classed turns are fenced out without brain:read_pii, served with it', async () => {
    const piiEpisode: Row = {
      id: 'episode:e3',
      conversationId: 'conv-1',
      speaker: 'Caroline',
      text: 'My phone number is 555-0100, call me about the trip.',
      occurredAt: '2026-07-03T10:00:00.000Z',
      piiClass: ['contact'],
    };
    const fact: Row = {
      ...FACT_GLOBAL,
      source: {
        ...(FACT_GLOBAL.source as Row),
        episodeIds: ['episode:e1', 'episode:e3'],
      },
    };
    const stack = makeStack({
      factsByCompany: { co_a: [fact] },
      episodesByCompany: { co_a: [...EPISODES, piiEpisode] },
    });
    const without = await stack.svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ,
    });
    expect(without.episodes.map((e) => e.episodeId)).toEqual(['episode:e1']);
    const episodeQuery = stack.queries.find((q) => q.sql.includes('FROM episode'));
    expect(episodeQuery?.sql).toContain('piiClass IS NONE');

    const withScope = await makeStack({
      factsByCompany: { co_a: [fact] },
      episodesByCompany: { co_a: [...EPISODES, piiEpisode] },
    }).svc.getProvenance({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ_PII,
    });
    expect(withScope.episodes.map((e) => e.episodeId)).toEqual(['episode:e1', 'episode:e3']);
  });
});

describe('registry-backed row policy (scope-fenced predicates)', () => {
  const FENCED_FACT: Row = {
    ...FACT_GLOBAL,
    predicate: 'health_status',
  };
  const policy = {
    health_status: { requiresScope: 'brain:read_pii', piiClass: 'health' },
  };

  it('a scope-fenced predicate is a 404 to callers without the scope', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [FENCED_FACT] },
      policy,
    });
    await expect(svc.getFact({ companyId: 'co_a', factId: 'f1', scopes: READ })).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      svc.getProvenance({ companyId: 'co_a', factId: 'f1', scopes: READ }),
    ).rejects.toThrow(NotFoundException);
  });

  it('the same fact resolves for a caller holding the scope', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [FENCED_FACT] },
      episodesByCompany: { co_a: EPISODES },
      policy,
    });
    const res = await svc.getFact({
      companyId: 'co_a',
      factId: 'f1',
      scopes: READ_PII,
    });
    expect(res.aspect).toBe('health_status');
  });
});

describe('FACTS_API_ENABLED gate (controller)', () => {
  const saved = process.env.FACTS_API_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTS_API_ENABLED;
    else process.env.FACTS_API_ENABLED = saved;
  });

  function makeController(): {
    ctl: FactsController;
    facts: {
      getFact: jest.Mock;
      getProvenance: jest.Mock;
      retract: jest.Mock;
    };
    req: AuthenticatedRequest;
  } {
    const facts = {
      getFact: jest.fn(async () => ({ factId: 'knowledge_fact:f1' })),
      getProvenance: jest.fn(async () => ({
        factId: 'knowledge_fact:f1',
        episodes: [],
      })),
      retract: jest.fn(async () => ({
        factId: 'knowledge_fact:f1',
        retractedAt: '2026-08-21T00:00:00.000Z',
        cascadedFactIds: [],
        revivedFactIds: [],
      })),
    };
    return {
      ctl: new FactsController(facts as unknown as FactsService),
      facts,
      req: {
        brainAuth: {
          companyId: 'co_a',
          scopes: ['brain:read', 'brain:write'],
        },
      } as unknown as AuthenticatedRequest,
    };
  }

  it('flag off (default): both GET routes 404 before touching the service', async () => {
    delete process.env.FACTS_API_ENABLED;
    const { ctl, facts, req } = makeController();
    await expect(ctl.get(req, 'f1')).rejects.toThrow(NotFoundException);
    await expect(ctl.provenance(req, 'f1')).rejects.toThrow(NotFoundException);
    expect(facts.getFact).not.toHaveBeenCalled();
    expect(facts.getProvenance).not.toHaveBeenCalled();
  });

  it('flag off: retract stays available (write/GDPR path is flag-independent)', async () => {
    delete process.env.FACTS_API_ENABLED;
    const { ctl, facts, req } = makeController();
    const dto = {
      reason: 'user request',
      retractedBy: { source: 'human' },
    } as RetractFactDto;
    const res = await ctl.retract(req, 'f1', dto);
    expect(facts.retract).toHaveBeenCalledTimes(1);
    expect(res.factId).toBe('knowledge_fact:f1');
  });

  it('flag on: GET routes reach the service with the request auth', async () => {
    process.env.FACTS_API_ENABLED = '1';
    const { ctl, facts, req } = makeController();
    await ctl.get(req, 'f1');
    await ctl.provenance(req, 'f1');
    expect(facts.getFact).toHaveBeenCalledWith({
      companyId: 'co_a',
      factId: 'f1',
      scopes: ['brain:read', 'brain:write'],
    });
    expect(facts.getProvenance).toHaveBeenCalledWith({
      companyId: 'co_a',
      factId: 'f1',
      scopes: ['brain:read', 'brain:write'],
    });
  });
});

/**
 * Release blocker (audit 2026-08-21 P0): retract used to mutate with no
 * ownership fence. These pin the fence matrix — every deny throws
 * BEFORE any mutation reaches the DB (the stub records queries; a
 * SELECT is the only shape a denied retract may issue).
 */
describe('FactsService.retract() — ownership fence', () => {
  const WRITE = ['brain:write'] as BrainScope[];
  const WRITE_ADMIN = ['brain:write', 'brain:admin'] as BrainScope[];
  const dto = { reason: 'test' } as RetractFactDto;

  const USER_FACT_U2: Row = {
    id: 'knowledge_fact:f1',
    predicate: 'preference',
    object: 'private note',
    status: 'active',
    userId: 'u2',
    source: { vertical: 'dialogue', recorder: 'r' },
  };

  const onlySelects = (queries: Recorded[]) =>
    queries.every((q) => q.sql.trimStart().toUpperCase().startsWith('SELECT'));

  it("user-bound token: another user's fact → 404, zero mutations", async () => {
    const { svc, queries } = makeStack({
      factsByCompany: { co_a: [USER_FACT_U2] },
    });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u1' }, async () => {
      await expect(
        svc.retract({
          companyId: 'co_a',
          factId: 'f1',
          dto,
          callerScopes: WRITE,
        }),
      ).rejects.toThrow(NotFoundException);
    });
    expect(onlySelects(queries)).toBe(true);
  });

  it('user-bound token: tenant-global fact without brain:admin → 403, zero mutations', async () => {
    const { svc, queries } = makeStack({
      factsByCompany: { co_a: [{ ...FACT_GLOBAL }] },
    });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u1' }, async () => {
      await expect(
        svc.retract({
          companyId: 'co_a',
          factId: 'f1',
          dto,
          callerScopes: WRITE,
        }),
      ).rejects.toThrow('requires an M2M token or brain:admin');
    });
    expect(onlySelects(queries)).toBe(true);
  });

  it('user-bound token: OWN fact passes the fence (mutation reached)', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [{ ...USER_FACT_U2, userId: 'u1' }] },
    });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u1' }, async () => {
      // The stub has no dbMerge surface — reaching the mutation step
      // (past every fence) throws a non-HTTP error, which is the
      // assertion: the fence did NOT stop an owner.
      await expect(
        svc.retract({
          companyId: 'co_a',
          factId: 'f1',
          dto,
          callerScopes: WRITE,
        }),
      ).rejects.not.toThrow(NotFoundException);
    });
  });

  it('user-bound token + brain:admin: tenant-global fact passes the fence', async () => {
    const { svc } = makeStack({
      factsByCompany: { co_a: [{ ...FACT_GLOBAL }] },
    });
    await runWithRequestContext({ correlationId: 'test', authUserId: 'u1' }, async () => {
      await expect(
        svc.retract({
          companyId: 'co_a',
          factId: 'f1',
          dto,
          callerScopes: WRITE_ADMIN,
        }),
      ).rejects.not.toThrow(NotFoundException);
    });
  });

  it('scope-fenced predicate → 404 for callers without the scope, zero mutations', async () => {
    const { svc, queries } = makeStack({
      factsByCompany: { co_a: [{ ...FACT_GLOBAL }] },
      policy: {
        preference: { requiresScope: 'brain:read_pii', piiClass: 'none' },
      },
    });
    await expect(
      svc.retract({ companyId: 'co_a', factId: 'f1', dto, callerScopes: WRITE }),
    ).rejects.toThrow(NotFoundException);
    expect(onlySelects(queries)).toBe(true);
  });
});
