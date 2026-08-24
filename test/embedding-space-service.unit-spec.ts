/**
 * Multilingual Tier 2 — EmbeddingSpaceService (zero-downtime protocol).
 *
 * Proves:
 *   - flags OFF (default): activeSpaceFor returns the current provider space
 *     with NO db read — byte-identical serving; the mutating ops refuse.
 *   - begin arms dual-write into the target (gated by DUAL_WRITE).
 *   - cutover is ATOMIC (a single UPSERT flipping activeSpace ← target and
 *     clearing the target) and refuses unless that migration is in flight.
 */
import { EmbeddingSpaceService } from '../src/ai/embedder/embedding-space.service';

const PROVIDER_SPACE = 'openai:text-embedding-3-small:1536:l2';
const TARGET_SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';

interface Mutation {
  sql: string;
  params: Record<string, unknown> | undefined;
}

function makeSvc(opts: {
  active?: string | undefined;
  dualWrite?: string | undefined;
  stateRow?: Record<string, unknown> | null | undefined;
}) {
  const mutations: Mutation[] = [];
  let selects = 0;
  // Mutable state seeded from the initial row so that reads AFTER an UPSERT
  // reflect the write (the real singleton row behaves this way).
  let current: Record<string, unknown> | null = opts.stateRow ?? null;
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (/UPSERT/.test(sql)) {
        mutations.push({ sql, params });
        // Apply the recognizable mutation to the mutable state.
        if (sql.includes('activeSpace = $target')) {
          current = {
            activeSpace: params?.target,
            targetSpace: null,
            dualWrite: false,
            phase: 'cut_over',
          };
        } else if (sql.includes('dualWrite = true')) {
          current = {
            activeSpace: params?.active,
            targetSpace: params?.target,
            dualWrite: true,
            phase: 'dual_write',
          };
        } else {
          current = { ...(current ?? {}), targetSpace: null, dualWrite: false, phase: 'idle' };
        }
        return [[]];
      }
      selects += 1; // SELECT FROM embedding_space_state:current
      return [current ? [current] : []];
    },
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as never;
  const embedder = { primarySpaceId: () => PROVIDER_SPACE } as never;
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'EMBEDDING_SPACE_ACTIVE') return opts.active;
      if (k === 'EMBEDDING_SPACE_DUAL_WRITE') return opts.dualWrite;
      return def;
    },
  } as never;
  return {
    svc: new EmbeddingSpaceService(surreal, embedder, config),
    mutations,
    selectCount: () => selects,
  };
}

describe('EmbeddingSpaceService — resolver defaults (flags off ⇒ byte-identical)', () => {
  it('activeSpaceFor returns the provider space with NO db read when ACTIVE is off', async () => {
    const { svc, selectCount } = makeSvc({ active: undefined });
    expect(await svc.activeSpaceFor('acme')).toBe(PROVIDER_SPACE);
    expect(selectCount()).toBe(0);
  });

  it('targetSpaceFor is null when DUAL_WRITE is off', async () => {
    const { svc } = makeSvc({
      dualWrite: undefined,
      stateRow: { targetSpace: TARGET_SPACE, dualWrite: true },
    });
    expect(await svc.targetSpaceFor('acme')).toBeNull();
  });

  it('activeSpaceFor reads the stored active space when ACTIVE is on', async () => {
    const { svc } = makeSvc({ active: '1', stateRow: { activeSpace: TARGET_SPACE } });
    expect(await svc.activeSpaceFor('acme')).toBe(TARGET_SPACE);
  });

  it('activeSpaceFor falls back to the provider space when no state row exists', async () => {
    const { svc } = makeSvc({ active: '1', stateRow: null });
    expect(await svc.activeSpaceFor('acme')).toBe(PROVIDER_SPACE);
  });
});

describe('EmbeddingSpaceService — begin migration', () => {
  it('refuses when DUAL_WRITE is off', async () => {
    const { svc } = makeSvc({ dualWrite: undefined });
    await expect(svc.beginMigration('acme', TARGET_SPACE)).rejects.toThrow(
      /EMBEDDING_SPACE_DUAL_WRITE is off/i,
    );
  });

  it('arms dual-write into the target space', async () => {
    const { svc, mutations } = makeSvc({ dualWrite: '1', active: '1', stateRow: null });
    await svc.beginMigration('acme', TARGET_SPACE);
    const upsert = mutations.find((m) => m.sql.includes('dualWrite = true'));
    expect(upsert).toBeDefined();
    expect(upsert!.params?.target).toBe(TARGET_SPACE);
    expect(upsert!.sql).toContain("phase = 'dual_write'");
  });

  it('refuses to migrate into the already-active space', async () => {
    const { svc } = makeSvc({ dualWrite: '1', active: undefined });
    await expect(svc.beginMigration('acme', PROVIDER_SPACE)).rejects.toThrow(
      /equals the active space/i,
    );
  });
});

describe('EmbeddingSpaceService — atomic cutover', () => {
  it('refuses when ACTIVE is off', async () => {
    const { svc } = makeSvc({ active: undefined });
    await expect(svc.cutover('acme', TARGET_SPACE)).rejects.toThrow(
      /EMBEDDING_SPACE_ACTIVE is off/i,
    );
  });

  it('refuses unless a migration into that target is in flight', async () => {
    const { svc } = makeSvc({
      active: '1',
      stateRow: { activeSpace: PROVIDER_SPACE, targetSpace: null },
    });
    await expect(svc.cutover('acme', TARGET_SPACE)).rejects.toThrow(/no migration into/i);
  });

  it('flips active ← target in a SINGLE atomic UPSERT and clears the target', async () => {
    const { svc, mutations } = makeSvc({
      active: '1',
      stateRow: { activeSpace: PROVIDER_SPACE, targetSpace: TARGET_SPACE, dualWrite: true },
    });
    const state = await svc.cutover('acme', TARGET_SPACE);
    expect(state.activeSpace).toBe(TARGET_SPACE);

    // Exactly one mutation statement — the atomic flip.
    expect(mutations).toHaveLength(1);
    const sql = mutations[0]!.sql;
    expect(sql).toContain('activeSpace = $target');
    expect(sql).toContain('targetSpace = NONE');
    expect(sql).toContain('dualWrite = false');
    expect(mutations[0]!.params?.target).toBe(TARGET_SPACE);
  });
});
