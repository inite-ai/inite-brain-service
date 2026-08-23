/**
 * G4 strategy-memory lane (docs/roadmap/sota-gap-build-2026-08.md) —
 * the retrieval contract (k hard-capped at 2, default 1; similarity
 * floor; only 'active' served), the dedup-merge decision handling
 * (Mem0 ADD/UPDATE/NOOP), the lifecycle sweep (nContradict ≥ 2 / 90d
 * unvalidated → deprecated), and the STRUCTURAL leakage pin: the fact
 * retrieval stack must never touch the strategy_memory table — the
 * separate-store isolation is the design's load-bearing guarantee.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  StrategyMemoryService,
  clampStrategyK,
  shouldDeprecate,
  renderStrategyNote,
  STRATEGY_RETRIEVAL_MAX_K,
  type ScoredStrategyItem,
  type StrategyItem,
} from '../src/strategy/strategy-memory.service';
import {
  parseMergeDecision,
  mergeEvidence,
} from '../src/strategy/strategy-distill.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';

// ── stubs ────────────────────────────────────────────────────────────

/** Embedder keyed on a text→vector map; unknown text = zero vector. */
function stubEmbedder(vectors: Record<string, number[]>): EmbedderService {
  return {
    embed: async (text: string) => vectors[text] ?? [0, 0],
  } as unknown as EmbedderService;
}

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

/** Surreal stub: withCompany hands out a db whose query is scripted. */
function stubSurreal(
  respond: (sql: string, params?: Record<string, unknown>) => unknown[],
  calls: QueryCall[] = [],
): SurrealService {
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      return respond(sql, params);
    },
  };
  return {
    withCompany: async (_companyId: string, fn: (d: unknown) => unknown) =>
      fn(db),
  } as unknown as SurrealService;
}

function stubConfig(env: Record<string, string>): ConfigService {
  return {
    get: (key: string, dflt?: string) => env[key] ?? dflt,
  } as unknown as ConfigService;
}

const BOTH_ON = {
  STRATEGY_MEMORY_ENABLED: '1',
  STRATEGY_RETRIEVAL_ENABLED: '1',
};

function row(over: Partial<Record<string, unknown>> = {}) {
  const { id, ...rest } = over;
  return {
    companyId: 'c1',
    title: 'temporal questions need the date table',
    situation: 'temporal question class',
    strategy: 'Compute intervals from the date table, never freehand.',
    polarity: 'do',
    status: 'active',
    evidence: { nSupport: 1, nContradict: 0 },
    embedding: [1, 0],
    scope: 'tenant',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...rest,
    id: `strategy_memory:${String(id ?? 'a1')}`,
  };
}

// ── k-cap ────────────────────────────────────────────────────────────

describe('strategy retrieval k-cap (ReasoningBank k-sensitivity)', () => {
  it('clamps k into [1, 2]: default 1, hard cap 2', () => {
    expect(clampStrategyK()).toBe(1);
    expect(clampStrategyK(undefined)).toBe(1);
    expect(clampStrategyK(0)).toBe(1);
    expect(clampStrategyK(-3)).toBe(1);
    expect(clampStrategyK(1)).toBe(1);
    expect(clampStrategyK(2)).toBe(2);
    expect(clampStrategyK(3)).toBe(2);
    expect(clampStrategyK(100)).toBe(2);
    expect(clampStrategyK(Number.NaN)).toBe(1);
    expect(STRATEGY_RETRIEVAL_MAX_K).toBe(2);
  });

  it('retrieve(k=5) serves at most 2 items even with 3 matches', async () => {
    const svc = new StrategyMemoryService(
      stubSurreal((sql) =>
        sql.includes('FROM strategy_memory')
          ? [[row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })]]
          : [[]],
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    const out = await svc.retrieve('c1', 'q', 5);
    expect(out).toHaveLength(2);
  });

  it('retrieve without k serves exactly 1 item', async () => {
    const svc = new StrategyMemoryService(
      stubSurreal((sql) =>
        sql.includes('FROM strategy_memory')
          ? [[row({ id: 'a1' }), row({ id: 'a2' })]]
          : [[]],
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    const out = await svc.retrieve('c1', 'q');
    expect(out).toHaveLength(1);
  });
});

// ── similarity floor ─────────────────────────────────────────────────

describe('strategy retrieval similarity floor', () => {
  it('drops items below the floor; best-first above it', async () => {
    // query [1,0]: a1 sim=1.0, a2 sim=0.0 (orthogonal) — floor 0.4
    // keeps only a1.
    const svc = new StrategyMemoryService(
      stubSurreal((sql) =>
        sql.includes('FROM strategy_memory')
          ? [[row({ id: 'a2', embedding: [0, 1] }), row({ id: 'a1' })]]
          : [[]],
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    const out = await svc.retrieve('c1', 'q', 2);
    expect(out.map((i) => i.strategyId)).toEqual(['strategy_memory:a1']);
    expect(out[0]!.similarity).toBeCloseTo(1.0);
  });

  it('an irrelevant best-match serves nothing (floor wins over k)', async () => {
    const svc = new StrategyMemoryService(
      stubSurreal((sql) =>
        sql.includes('FROM strategy_memory')
          ? [[row({ id: 'a1', embedding: [0, 1] })]]
          : [[]],
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    expect(await svc.retrieve('c1', 'q')).toEqual([]);
  });

  it('the floor is the STRATEGY_SIMILARITY_FLOOR knob (default 0.4)', async () => {
    // sim = cos([1,0],[1,1]) ≈ 0.707: below a 0.9 floor, above default.
    const make = (env: Record<string, string>) =>
      new StrategyMemoryService(
        stubSurreal((sql) =>
          sql.includes('FROM strategy_memory')
            ? [[row({ id: 'a1', embedding: [1, 1] })]]
            : [[]],
        ),
        stubEmbedder({ q: [1, 0] }),
        stubConfig(env),
      );
    expect(await make(BOTH_ON).retrieve('c1', 'q')).toHaveLength(1);
    expect(
      await make({ ...BOTH_ON, STRATEGY_SIMILARITY_FLOOR: '0.9' }).retrieve(
        'c1',
        'q',
      ),
    ).toEqual([]);
  });
});

// ── status filter + flag gates ───────────────────────────────────────

describe('strategy retrieval status filter and flag gates', () => {
  it('serving queries restrict to status=active only', async () => {
    const calls: QueryCall[] = [];
    const svc = new StrategyMemoryService(
      stubSurreal((sql) => (sql.includes('FROM strategy_memory') ? [[]] : [[]]), calls),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    await svc.retrieve('c1', 'q');
    const serving = calls.find((c) => c.sql.includes('FROM strategy_memory'));
    expect(serving?.params?.statuses).toEqual(['active']);
  });

  it('findSimilar (dedup write path) sees candidate+active, floor-free', async () => {
    const calls: QueryCall[] = [];
    const svc = new StrategyMemoryService(
      stubSurreal(
        (sql) =>
          sql.includes('FROM strategy_memory')
            ? [[row({ id: 'c1row', status: 'candidate', embedding: [0, 1] })]]
            : [[]],
        calls,
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON),
    );
    const out = await svc.findSimilar('c1', 'q');
    // Orthogonal (sim 0) still returned — the merge LLM judges.
    expect(out).toHaveLength(1);
    const call = calls.find((c) => c.sql.includes('FROM strategy_memory'));
    expect(call?.params?.statuses).toEqual(['candidate', 'active']);
  });

  it('retrieve is empty (and hits no DB) when either flag is off', async () => {
    const gateCases: Array<Record<string, string>> = [
      {},
      { STRATEGY_MEMORY_ENABLED: '1' },
      { STRATEGY_RETRIEVAL_ENABLED: '1' },
    ];
    for (const env of gateCases) {
      const calls: QueryCall[] = [];
      const svc = new StrategyMemoryService(
        stubSurreal(() => [[row()]], calls),
        stubEmbedder({ q: [1, 0] }),
        stubConfig(env),
      );
      expect(await svc.retrieve('c1', 'q')).toEqual([]);
      expect(calls).toHaveLength(0);
    }
  });
});

// ── dedup-merge decision handling ────────────────────────────────────

describe('dedup-merge decision handling (Mem0 ADD/UPDATE/NOOP)', () => {
  const ids = ['strategy_memory:x1', 'strategy_memory:x2'];

  it('parses the three actions', () => {
    expect(parseMergeDecision('{"action":"ADD"}', ids)).toEqual({
      action: 'ADD',
    });
    expect(parseMergeDecision('{"action":"NOOP"}', ids)).toEqual({
      action: 'NOOP',
    });
    expect(
      parseMergeDecision(
        '{"action":"UPDATE","targetId":"strategy_memory:x2","strategy":"s","situation":"c"}',
        ids,
      ),
    ).toEqual({
      action: 'UPDATE',
      targetId: 'strategy_memory:x2',
      strategy: 's',
      situation: 'c',
    });
  });

  it('garbage degrades to NOOP — a malformed decision must not grow the table', () => {
    expect(parseMergeDecision(undefined, ids).action).toBe('NOOP');
    expect(parseMergeDecision('', ids).action).toBe('NOOP');
    expect(parseMergeDecision('not json', ids).action).toBe('NOOP');
    expect(parseMergeDecision('{"action":"DELETE"}', ids).action).toBe('NOOP');
  });

  it('UPDATE with an unknown/hallucinated targetId degrades to NOOP', () => {
    expect(
      parseMergeDecision(
        '{"action":"UPDATE","targetId":"strategy_memory:nope"}',
        ids,
      ).action,
    ).toBe('NOOP');
    expect(parseMergeDecision('{"action":"UPDATE"}', ids).action).toBe('NOOP');
  });

  it('mergeEvidence sums vote counters and unions run provenance', () => {
    const merged = mergeEvidence(
      {
        source: 'post_mortem',
        runIds: ['r1'],
        nSupport: 2,
        nContradict: 1,
        lastValidatedAt: '2026-08-01T00:00:00.000Z',
      },
      { runIds: ['r1', 'r2'], nSupport: 1, nContradict: 0, lastValidatedAt: '2026-08-20T00:00:00.000Z' },
    );
    expect(merged.nSupport).toBe(3);
    expect(merged.nContradict).toBe(1);
    expect(merged.runIds).toEqual(['r1', 'r2']);
    expect(merged.lastValidatedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(merged.source).toBe('post_mortem');
  });
});

// ── lifecycle sweep ──────────────────────────────────────────────────

describe('strategy lifecycle sweep (auto-deprecation)', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const base: Pick<StrategyItem, 'evidence' | 'createdAt'> = {
    evidence: { nContradict: 0, lastValidatedAt: '2026-08-20T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('deprecates on nContradict >= 2', () => {
    expect(shouldDeprecate(base, now)).toBe(false);
    expect(
      shouldDeprecate({ ...base, evidence: { ...base.evidence, nContradict: 1 } }, now),
    ).toBe(false);
    expect(
      shouldDeprecate({ ...base, evidence: { ...base.evidence, nContradict: 2 } }, now),
    ).toBe(true);
    expect(
      shouldDeprecate({ ...base, evidence: { ...base.evidence, nContradict: 5 } }, now),
    ).toBe(true);
  });

  it('deprecates past 90 days unvalidated; createdAt anchors the never-validated', () => {
    const recent = { evidence: { lastValidatedAt: '2026-06-01T00:00:00.000Z' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const stale = { evidence: { lastValidatedAt: '2026-05-01T00:00:00.000Z' }, createdAt: '2026-01-01T00:00:00.000Z' };
    expect(shouldDeprecate(recent, now)).toBe(false);
    expect(shouldDeprecate(stale, now)).toBe(true);
    // Never validated → createdAt is the staleness anchor.
    expect(
      shouldDeprecate({ evidence: {}, createdAt: '2026-08-01T00:00:00.000Z' }, now),
    ).toBe(false);
    expect(
      shouldDeprecate({ evidence: {}, createdAt: '2026-01-01T00:00:00.000Z' }, now),
    ).toBe(true);
  });

  it('deprecateSweep flips exactly the qualifying rows', async () => {
    const calls: QueryCall[] = [];
    const svc = new StrategyMemoryService(
      stubSurreal(
        (sql) =>
          sql.includes('FROM strategy_memory')
            ? [
                [
                  row({ id: 'keep', evidence: { nContradict: 0, lastValidatedAt: '2026-08-20T00:00:00.000Z' } }),
                  row({ id: 'contradicted', evidence: { nContradict: 2 } }),
                  row({ id: 'stale', evidence: { lastValidatedAt: '2026-01-01T00:00:00.000Z' } }),
                ],
              ]
            : [[]],
        calls,
      ),
      stubEmbedder({}),
      stubConfig({ STRATEGY_MEMORY_ENABLED: '1' }),
    );
    const stats = await svc.deprecateSweep('c1', new Date('2026-08-23T00:00:00.000Z'));
    expect(stats).toEqual({ companyId: 'c1', scanned: 3, deprecated: 2 });
    const updates = calls.filter((c) => c.sql.includes("status = 'deprecated'"));
    expect(updates.map((c) => c.params?.tail).sort()).toEqual([
      'contradicted',
      'stale',
    ]);
  });
});

// ── advisory rendering ───────────────────────────────────────────────

describe('renderStrategyNote', () => {
  it('renders polarity tag + preconditions + lesson', () => {
    const item = {
      title: 'commit on dated conflicts',
      situation: 'knowledge-update questions',
      strategy: 'Prefer the latest dated value.',
      polarity: 'avoid',
    } as unknown as ScoredStrategyItem;
    expect(renderStrategyNote(item)).toBe(
      '[AVOID] commit on dated conflicts — applies when: knowledge-update questions. Prefer the latest dated value.',
    );
  });
});

// ── STRUCTURAL leakage pin ───────────────────────────────────────────

/**
 * The separate-table guarantee, pinned at the source level: the fact
 * retrieval stack (search + ingest + facts + multi-hop) must never
 * reference the strategy_memory table or the strategy module. If this
 * fails, someone unioned strategy rows into a fact lane — the exact
 * leakage the G4 design makes structurally impossible.
 */
describe('structural leakage pin — fact lanes never touch strategy_memory', () => {
  const SRC = join(__dirname, '..', 'src');
  const FACT_STACK_DIRS = ['search', 'ingest', 'facts', 'multi-hop'];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('no fact-stack source mentions strategy_memory or imports src/strategy', () => {
    const offenders: string[] = [];
    for (const dir of FACT_STACK_DIRS) {
      for (const file of walk(join(SRC, dir))) {
        const text = readFileSync(file, 'utf8');
        if (text.includes('strategy_memory') || text.includes("/strategy/")) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the synthesize side reaches strategy ONLY through the advisory collector', () => {
    // Module wiring (DI) is not data flow — the collector is the one
    // place strategy content enters a prompt.
    const allowed = new Set([
      'evidence-collector.service.ts',
      'synthesize.module.ts',
    ]);
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'synthesize'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes("from '../strategy/")) continue;
      const name = file.split('/').pop() ?? file;
      if (!allowed.has(name)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
