import { ConfigService } from '@nestjs/config';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import {
  WindowDeriverService,
  WINDOW_DERIVER_VERSION,
} from '../src/admin/window-deriver.service';
import {
  STAGING_SUFFIX,
  deriveLeaseName,
  promoteStaging,
  stagingNamespace,
  sweepStagingRows,
} from '../src/admin/derive-staging';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { LeaderLeaseService } from '../src/jobs/leader-lease.service';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';

/**
 * Audit 2026-08-19 P1 — derive non-atomicity. The contract under test:
 *
 *   - every row a run writes lands in `<version>.staging`, never the
 *     final version;
 *   - a CLEAN run promotes staging → final in one DELETE-then-UPDATE
 *     transaction per table; prior final rows die in the same flip;
 *   - a failed or degraded run leaves the final version untouched and
 *     sweeps its staging rows; the registry never says 'built';
 *   - a concurrent derive for the same (tenant, version) fails fast;
 *   - the registry row becomes 'built'/'live' only AFTER the flip.
 */

const STAGING = `${WINDOW_DERIVER_VERSION}${STAGING_SUFFIX}`;

const ONE_PROP = {
  propositions: [
    {
      subject: 'Caroline',
      aspect: 'pets',
      proposition: "Caroline's cats are named Luna and Oliver.",
      occurred_on: null,
      turns: [1],
    },
  ],
};

interface Recorded {
  sql: string;
  params?: Record<string, unknown>;
}

function makeSvc(
  llm: unknown,
  opts?: {
    conversations?: Array<{ conversationId: string; n: number }>;
    /** Make the staging existence probes report leftover rows. */
    stagingRows?: boolean;
    registry?: Partial<ProjectionRegistryService>;
    leaderLease?: Partial<LeaderLeaseService>;
    /** Called on every db query — lets a test interleave markers. */
    onQuery?: (sql: string) => void;
  },
): {
  svc: WindowDeriverService;
  queries: Recorded[];
  derived: Array<Record<string, unknown>>;
} {
  const queries: Recorded[] = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      opts?.onQuery?.(sql);
      if (sql.includes('GROUP BY conversationId'))
        return [opts?.conversations ?? [{ conversationId: 'conv-1', n: 3 }]];
      if (sql.includes('FROM episode'))
        return [
          [
            {
              id: 'episode:e0',
              speaker: 'Melanie',
              text: 'Do you have pets?',
              occurredAt: '2023-05-01T10:00:00Z',
            },
            {
              id: 'episode:e1',
              speaker: 'Caroline',
              text: 'Luna and Oliver! They are so sweet',
              occurredAt: '2023-05-01T10:01:00Z',
            },
          ],
        ];
      if (sql.includes('FROM knowledge_entity'))
        return [[{ id: 'knowledge_entity:car' }]];
      // Staging sweep existence probes.
      if (
        sql.includes('SELECT id FROM knowledge_fact') ||
        sql.includes('SELECT id FROM conversation_digest')
      )
        return [opts?.stagingRows ? [{ id: 'row:x' }] : []];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'sk' : d),
    getOrThrow: () => 'sk',
  } as unknown as ConfigService;
  const embedding = {
    embedMany: async (t: string[]) => t.map(() => [1, 0]),
  } as unknown as FactEmbeddingService;
  const derived: Array<Record<string, unknown>> = [];
  const factResolver = {
    resolveDerivedBatch: async (
      _db: unknown,
      rows: Array<Record<string, unknown>>,
    ) => {
      derived.push(...rows);
      return rows.map(() => ({ outcome: 'INSERTED' }));
    },
  } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService;
  const svc = new WindowDeriverService(
    surreal,
    config,
    embedding,
    new EpisodeReadStoreService(surreal),
    factResolver,
    opts?.registry as ProjectionRegistryService | undefined,
    undefined,
    opts?.leaderLease as LeaderLeaseService | undefined,
  );
  (svc as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(llm) } }],
        }),
      },
    },
  };
  return { svc, queries, derived };
}

const failingLlm = {
  chat: {
    completions: {
      create: async () => {
        throw new Error('llm down');
      },
    },
  },
};

describe('derive staging namespace (audit 2026-08-19 P1)', () => {
  it('all in-run rows land under <version>.staging; final only in the flip', async () => {
    const { svc, queries, derived } = makeSvc(ONE_PROP);
    const res = await svc.run('co_x');
    expect(res.status).toBe('ok');
    // Resolver rows: staged derivedVersion, FINAL provenance recorder
    // (source survives the flip untouched).
    expect(derived.length).toBeGreaterThan(0);
    for (const row of derived) {
      expect(row.derivedVersion).toBe(STAGING);
      expect((row.source as Record<string, unknown>).recorder).toBe(
        WINDOW_DERIVER_VERSION,
      );
    }
    // Every non-flip statement that touches a derivedVersion param
    // targets staging; only the flip transaction names the final.
    for (const q of queries) {
      if (q.sql.includes('BEGIN TRANSACTION')) continue;
      if (q.params && 'version' in q.params) {
        expect(q.params.version).toBe(STAGING);
      }
    }
    const flips = queries.filter((q) => q.sql.includes('BEGIN TRANSACTION'));
    expect(flips.length).toBe(2); // knowledge_fact, then conversation_digest
    expect(flips[0].sql).toContain(
      'DELETE knowledge_fact WHERE derivedVersion = $final',
    );
    expect(flips[0].sql).toContain(
      'UPDATE knowledge_fact SET derivedVersion = $final',
    );
    expect(flips[1].sql).toContain(
      'DELETE conversation_digest WHERE derivedVersion = $final',
    );
    expect(flips[1].sql).toContain(
      'UPDATE conversation_digest SET derivedVersion = $final',
    );
    for (const flip of flips) {
      expect(flip.params).toMatchObject({
        final: WINDOW_DERIVER_VERSION,
        staging: STAGING,
      });
    }
  });

  it('failed run leaves the final version untouched and sweeps staging', async () => {
    const { svc, queries } = makeSvc(ONE_PROP, { stagingRows: true });
    (svc as unknown as { openai: unknown }).openai = failingLlm;
    const res = await svc.run('co_x');
    expect(res.status).toBe('failed');
    // No flip, no DELETE against the final version — the world readers
    // pin is byte-identical to before the run.
    expect(queries.some((q) => q.sql.includes('BEGIN TRANSACTION'))).toBe(
      false,
    );
    for (const q of queries) {
      if (q.params && 'version' in q.params) {
        expect(q.params.version).toBe(STAGING);
      }
    }
    // Best-effort staging GC ran (probe said rows exist → DELETE).
    const sweeps = queries.filter(
      (q) =>
        q.sql.includes('DELETE knowledge_fact WHERE derivedVersion = $version') ||
        q.sql.includes(
          'DELETE conversation_digest WHERE derivedVersion = $version',
        ),
    );
    expect(sweeps.length).toBeGreaterThan(0);
    for (const s of sweeps) expect(s.params?.version).toBe(STAGING);
  });

  it('degraded run: no flip, staging swept, registry fails — never built', async () => {
    const events: string[] = [];
    const registry = {
      begin: async () => void events.push('begin'),
      complete: async () => void events.push('complete'),
      fail: async () => void events.push('fail'),
    };
    const { svc, queries } = makeSvc(ONE_PROP, {
      conversations: [
        { conversationId: 'conv-1', n: 3 },
        { conversationId: 'conv-2', n: 3 },
      ],
      registry,
    });
    let calls = 0;
    const healthy = (svc as unknown as { openai: unknown }).openai as {
      chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } };
    };
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (...args: unknown[]) => {
            calls += 1;
            if (calls === 1) throw new Error('llm down');
            return healthy.chat.completions.create(...args);
          },
        },
      },
    };
    const res = await svc.run('co_x', { activate: true });
    expect(res.status).toBe('degraded');
    expect(res.conversations).toBe(1);
    // Pre-staging behavior landed the successful conversation in the
    // final world and marked the registry 'built'. Under atomic-flip
    // semantics a hole-y world is never promoted.
    expect(queries.some((q) => q.sql.includes('BEGIN TRANSACTION'))).toBe(
      false,
    );
    expect(res.activated).toBeUndefined();
    expect(events).toEqual(['begin', 'fail']);
  });

  it('orphaned staging rows of a crashed prior run are swept at start', async () => {
    const { svc, queries } = makeSvc(ONE_PROP, { stagingRows: true });
    await svc.run('co_x');
    const firstDelete = queries.findIndex(
      (q) =>
        q.sql.includes('DELETE knowledge_fact WHERE derivedVersion = $version'),
    );
    const firstEpisodeRead = queries.findIndex((q) =>
      q.sql.includes('GROUP BY conversationId'),
    );
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(firstEpisodeRead);
    expect(queries[firstDelete].params?.version).toBe(STAGING);
  });

  it("registry becomes 'built' only AFTER the flip transactions", async () => {
    const events: string[] = [];
    const registry = {
      begin: async () => void events.push('begin'),
      complete: async () => void events.push('complete'),
      fail: async () => void events.push('fail'),
    };
    const { svc } = makeSvc(ONE_PROP, {
      registry,
      onQuery: (sql) => {
        if (sql.includes('BEGIN TRANSACTION')) events.push('flip');
      },
    });
    const res = await svc.run('co_x');
    expect(res.status).toBe('ok');
    expect(events).toEqual(['begin', 'flip', 'flip', 'complete']);
  });

  it('targeted re-derive flips only that conversation and revives its supersede losers', async () => {
    const { svc, queries } = makeSvc(ONE_PROP);
    const res = await svc.run('co_x', { conversationId: 'conv-1' });
    expect(res.conversations).toBe(1);
    const flips = queries.filter((q) => q.sql.includes('BEGIN TRANSACTION'));
    expect(flips.length).toBe(2);
    // Conversation-scoped DELETE/UPDATE — a targeted flip must never
    // wipe the other conversations of the final world.
    expect(flips[0].sql).toContain('source.conversationId = $conv');
    expect(flips[0].sql).not.toMatch(
      /DELETE knowledge_fact WHERE derivedVersion = \$final;/,
    );
    // The 0014-shape revive of OTHER conversations' superseded losers
    // now runs against the FINAL world at flip time.
    expect(flips[0].sql).toContain("status = 'superseded'");
    expect(flips[0].sql).toContain('supersededBy IN');
    expect(flips[1].sql).toContain('conversationId = $conv');
    expect(flips[0].params?.conv).toBe('conv-1');
  });
});

describe('derive lease (concurrent derive rejection)', () => {
  function gatedLlm(): { gate: { resolve: () => void }; llm: unknown } {
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    return {
      gate: { resolve: release },
      llm: {
        chat: {
          completions: {
            create: async () => {
              await opened;
              return {
                choices: [
                  { message: { content: JSON.stringify(ONE_PROP) } },
                ],
              };
            },
          },
        },
      },
    };
  }

  it('a second concurrent derive for the same (tenant, version) fails fast', async () => {
    const { gate, llm } = gatedLlm();
    const a = makeSvc(ONE_PROP);
    (a.svc as unknown as { openai: unknown }).openai = llm;
    const first = a.svc.run('co_x');
    await new Promise((r) => setImmediate(r)); // let the lease land
    const b = makeSvc(ONE_PROP);
    await expect(b.svc.run('co_x')).rejects.toThrow(
      /derive already in flight/,
    );
    // A different tenant is a different lease — allowed concurrently.
    const c = makeSvc(ONE_PROP);
    await expect(c.svc.run('co_other')).resolves.toMatchObject({
      status: 'ok',
    });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'ok' });
    // Lease released in finally — a follow-up run proceeds.
    const d = makeSvc(ONE_PROP);
    await expect(d.svc.run('co_x')).resolves.toMatchObject({ status: 'ok' });
  });

  it('lease released even when the run fails', async () => {
    const a = makeSvc(ONE_PROP);
    (a.svc as unknown as { openai: unknown }).openai = failingLlm;
    const res = await a.svc.run('co_x');
    expect(res.status).toBe('failed');
    const b = makeSvc(ONE_PROP);
    await expect(b.svc.run('co_x')).resolves.toMatchObject({ status: 'ok' });
  });

  it('cross-pod: leader-lease refusal rejects before any write', async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const leaderLease = {
      tryAcquire: async (name: string) => {
        acquired.push(name);
        return false;
      },
      release: async (name: string) => void released.push(name),
    };
    const { svc, queries } = makeSvc(ONE_PROP, { leaderLease });
    await expect(svc.run('co_x')).rejects.toThrow(/derive already in flight/);
    expect(queries).toHaveLength(0);
    expect(acquired).toHaveLength(1);
    // Refused acquire holds nothing — nothing to release.
    expect(released).toHaveLength(0);
  });

  it('cross-pod: acquired lease is released in finally', async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const leaderLease = {
      tryAcquire: async (name: string) => {
        acquired.push(name);
        return true;
      },
      release: async (name: string) => void released.push(name),
    };
    const { svc } = makeSvc(ONE_PROP, { leaderLease });
    await svc.run('co_x');
    expect(acquired.length).toBeGreaterThanOrEqual(1);
    expect(released).toEqual([acquired[0]]);
  });

  it('deriveLeaseName stays in the unescaped leader_lease id charset', () => {
    const name = deriveLeaseName('Co:X-1 β', 'wd-v3s');
    expect(name).toMatch(/^derive_[a-z0-9_]+_[0-9a-f]{8}$/);
    // Distinct pairs must not collide after sanitization.
    expect(deriveLeaseName('co-x', 'wd-v2')).not.toBe(
      deriveLeaseName('co_x', 'wd-v2'),
    );
  });
});

describe('promoteStaging / sweepStagingRows primitives', () => {
  function mockDb() {
    const queries: Recorded[] = [];
    const db = {
      query: async <T>(
        sql: string,
        params?: Record<string, unknown>,
      ): Promise<T> => {
        queries.push({ sql, params });
        if (sql.includes('SELECT id FROM'))
          return [[{ id: 'row:x' }]] as unknown as T;
        return [[]] as unknown as T;
      },
    };
    return { queries, db };
  }

  it('full flip: one DELETE-then-UPDATE transaction per table', async () => {
    const { db, queries } = mockDb();
    await promoteStaging(db, stagingNamespace('wd-v9'));
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toContain('BEGIN TRANSACTION');
      expect(q.sql).toContain('COMMIT TRANSACTION');
      expect(q.params).toMatchObject({
        final: 'wd-v9',
        staging: 'wd-v9.staging',
      });
      // DELETE of the final world precedes the promoting UPDATE inside
      // the same transaction — readers see old world or new, never both.
      expect(q.sql.indexOf('DELETE')).toBeLessThan(q.sql.indexOf('UPDATE'));
    }
    expect(queries[0].sql).toContain('knowledge_fact');
    expect(queries[1].sql).toContain('conversation_digest');
  });

  it('targeted flip scopes every statement to the conversation', async () => {
    const { db, queries } = mockDb();
    await promoteStaging(db, stagingNamespace('wd-v9'), {
      conversationId: 'conv-7',
    });
    expect(queries).toHaveLength(2);
    expect(queries[0].params?.conv).toBe('conv-7');
    // Revive of cross-conversation supersede losers runs first, inside
    // the same transaction as the replace.
    expect(queries[0].sql.indexOf("status = 'active'")).toBeLessThan(
      queries[0].sql.indexOf('DELETE knowledge_fact'),
    );
    expect(queries[0].sql).toContain('source.conversationId = $conv');
    expect(queries[1].sql).toContain('conversationId = $conv');
  });

  it('sweep probes before deleting and scopes to the staging namespace', async () => {
    const { db, queries } = mockDb();
    await sweepStagingRows(db, 'wd-v9.staging');
    const deletes = queries.filter((q) => q.sql.startsWith('DELETE'));
    expect(deletes).toHaveLength(2);
    for (const d of deletes) {
      expect(d.params?.version).toBe('wd-v9.staging');
    }
    // Probe precedes each delete.
    expect(queries[0].sql).toContain('SELECT id FROM knowledge_fact');
    expect(queries[1].sql.startsWith('DELETE knowledge_fact')).toBe(true);
  });
});

describe('gc staging protection', () => {
  it('keeps <v>.staging while its base version is protected, reaps orphans', async () => {
    const queries: Recorded[] = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('GROUP BY derivedVersion'))
          return [
            [
              { derivedVersion: 'wd-live', n: 20 },
              { derivedVersion: 'wd-live.staging', n: 5 },
              { derivedVersion: 'wd-old.staging', n: 7 },
            ],
          ];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    const config = {
      get: (_k: string, d?: string) => d,
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0]),
    } as unknown as FactEmbeddingService;
    const registry = {
      list: async () => [{ name: 'facts', version: 'wd-live', status: 'live' }],
      dropVersions: async () => undefined,
    } as unknown as ProjectionRegistryService;
    const svc = new WindowDeriverService(
      surreal,
      config,
      embedding,
      new EpisodeReadStoreService(surreal),
      {
        resolveDerivedBatch: async () => [],
      } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService,
      registry,
    );
    const res = await svc.gc('co_x');
    // The in-flight (registry-protected) world keeps its staging rows;
    // the crashed orphan whose base is gone is reaped.
    expect(res.deleted).toEqual({ 'wd-old.staging': 7 });
  });
});
