/**
 * Strategy trajectories — experience-memory extension of G4 (bet #3,
 * Part 3 of docs/roadmap/measurable-economics-mri-2026-08.md). Pure-logic
 * coverage:
 *   · digesting is one-way and stable — raw args/results (secrets/PII) are
 *     NEVER stored verbatim, only short SHA-256 prefixes;
 *   · toToolStep / toTrajectory redact + cap;
 *   · renderStrategyNote is BYTE-IDENTICAL to pre-0098 without a
 *     trajectory, and appends the past-tool-path suffix (generator-only)
 *     with one;
 *   · the READ GATE: with STRATEGY_TRAJECTORIES_ENABLED off the SELECT
 *     projection never names the trajectory columns (so serving is
 *     byte-identical), and names them only when on.
 */
import { ConfigService } from '@nestjs/config';
import {
  StrategyMemoryService,
  renderStrategyNote,
  type ScoredStrategyItem,
} from '../src/strategy/strategy-memory.service';
import {
  TRAJECTORY_DIGEST_LEN,
  TRAJECTORY_MAX_STEPS,
  digestPayload,
  isVerifiedOutcome,
  renderTrajectorySuffix,
  toToolStep,
  toTrajectory,
  type ToolStep,
} from '../src/strategy/trajectory-digest';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';

// ── stubs (mirrors strategy-memory.unit-spec.ts) ─────────────────────────

function stubEmbedder(vectors: Record<string, number[]>): EmbedderService {
  return {
    embed: async (text: string) => vectors[text] ?? [0, 0],
  } as unknown as EmbedderService;
}

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

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
    withCompany: async (_companyId: string, fn: (d: unknown) => unknown) => fn(db),
  } as unknown as SurrealService;
}

function stubConfig(env: Record<string, string>): ConfigService {
  return {
    get: (key: string, dflt?: string) => env[key] ?? dflt,
  } as unknown as ConfigService;
}

const TRAJ_STEP: ToolStep = {
  tool: 'web_search',
  argsDigest: 'a1b2c3d4e5f60718',
  resultDigest: 'ffeeddccbbaa9988',
  ok: true,
};

function trajRow(over: Partial<Record<string, unknown>> = {}) {
  const { id, ...rest } = over;
  return {
    companyId: 'c1',
    title: 'onboarding lookup',
    situation: 'account-status question',
    strategy: 'Check the profile record first.',
    polarity: 'do',
    status: 'active',
    evidence: { nSupport: 1, nContradict: 0 },
    embedding: [1, 0],
    scope: 'tenant',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    trajectory: [TRAJ_STEP],
    verifiedOutcome: 'success',
    outcomeEvidenceRef: 'run:xyz',
    ...rest,
    id: `strategy_memory:${String(id ?? 'a1')}`,
  };
}

// ── digesting: one-way, stable, secret-safe ──────────────────────────────

describe('digestPayload — hashes, never raw payloads', () => {
  it('returns a short lowercase hex digest, not the payload', () => {
    const d = digestPayload({ apiKey: 'sk-SECRET-12345', q: 'hello' });
    expect(d).toMatch(new RegExp(`^[0-9a-f]{${TRAJECTORY_DIGEST_LEN}}$`));
    expect(d).not.toContain('sk-SECRET-12345');
    expect(d).not.toContain('hello');
  });

  it('is deterministic and stable across object key ordering', () => {
    expect(digestPayload({ a: 1, b: 2 })).toBe(digestPayload({ b: 2, a: 1 }));
    expect(digestPayload('same')).toBe(digestPayload('same'));
  });

  it('distinguishes different payloads', () => {
    expect(digestPayload({ q: 'a' })).not.toBe(digestPayload({ q: 'b' }));
  });

  it('handles undefined/null without leaking or throwing', () => {
    expect(digestPayload(undefined)).toMatch(/^[0-9a-f]+$/);
    expect(digestPayload(null)).toMatch(/^[0-9a-f]+$/);
  });
});

describe('toToolStep / toTrajectory — redact + cap', () => {
  it('stores DIGESTS of args/result, never the raw values', () => {
    const secretArgs = { token: 'bearer-abc-SECRET', url: 'https://x' };
    const secretResult = { body: 'private-user-data-XYZ' };
    const step = toToolStep({
      tool: 'http_fetch',
      args: secretArgs,
      result: secretResult,
      ok: true,
    });
    expect(step.tool).toBe('http_fetch');
    expect(step.ok).toBe(true);
    // Digests equal the deterministic hash and contain none of the secret.
    expect(step.argsDigest).toBe(digestPayload(secretArgs));
    expect(step.resultDigest).toBe(digestPayload(secretResult));
    const serialized = JSON.stringify(step);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('private-user-data-XYZ');
    expect(serialized).not.toContain('bearer-abc');
  });

  it('coerces ok to a STRICT boolean (only literal true is true) and sanitizes the tool name', () => {
    const zwsp = String.fromCharCode(0x200b); // zero-width space
    const step = toToolStep({ tool: `we${zwsp}ird`, args: {}, result: {}, ok: true });
    expect(step.ok).toBe(true);
    // zero-width space stripped by the shared text sanitizer.
    expect(step.tool).toBe('weird');
    // Strict `=== true`: a truthy-but-not-true ok defensively becomes false.
    expect(toToolStep({ tool: 't', args: {}, result: {}, ok: 1 as unknown as boolean }).ok).toBe(
      false,
    );
    expect(toToolStep({ tool: 't', args: {}, result: {}, ok: 0 as unknown as boolean }).ok).toBe(
      false,
    );
  });

  it('caps the stored trajectory at TRAJECTORY_MAX_STEPS', () => {
    const many = Array.from({ length: TRAJECTORY_MAX_STEPS + 10 }, (_, i) => ({
      tool: `t${i}`,
      args: { i },
      result: {},
      ok: true,
    }));
    expect(toTrajectory(many)).toHaveLength(TRAJECTORY_MAX_STEPS);
  });
});

describe('isVerifiedOutcome', () => {
  it('accepts only the three enum values', () => {
    expect(isVerifiedOutcome('success')).toBe(true);
    expect(isVerifiedOutcome('failure')).toBe(true);
    expect(isVerifiedOutcome('unknown')).toBe(true);
    expect(isVerifiedOutcome('bogus')).toBe(false);
    expect(isVerifiedOutcome(undefined)).toBe(false);
    expect(isVerifiedOutcome(1)).toBe(false);
  });
});

// ── advisory rendering: byte-identical without a trajectory ───────────────

describe('renderTrajectorySuffix', () => {
  it('is empty for an item with no trajectory (byte-identical fallback)', () => {
    expect(renderTrajectorySuffix({})).toBe('');
    expect(renderTrajectorySuffix({ trajectory: [] })).toBe('');
  });

  it('renders the tool path with per-step ok/fail and the verified outcome', () => {
    expect(
      renderTrajectorySuffix({
        trajectory: [
          { tool: 'web_search', argsDigest: 'x', resultDigest: 'y', ok: true },
          { tool: 'calc', argsDigest: 'x', resultDigest: 'y', ok: false },
        ],
        verifiedOutcome: 'success',
      }),
    ).toBe(' [past tool path: web_search(ok) → calc(fail), verified success]');
  });

  it('omits the outcome clause when there is no verified outcome', () => {
    expect(
      renderTrajectorySuffix({
        trajectory: [{ tool: 't', argsDigest: 'x', resultDigest: 'y', ok: true }],
      }),
    ).toBe(' [past tool path: t(ok)]');
  });
});

describe('renderStrategyNote — additive, generator-only', () => {
  const base = {
    title: 'commit on dated conflicts',
    situation: 'knowledge-update questions',
    strategy: 'Prefer the latest dated value.',
    polarity: 'do',
  } as unknown as ScoredStrategyItem;

  it('is BYTE-IDENTICAL to pre-0098 when the item carries no trajectory', () => {
    expect(renderStrategyNote(base)).toBe(
      '[DO] commit on dated conflicts — applies when: knowledge-update questions. Prefer the latest dated value.',
    );
  });

  it('appends the past-tool-path suffix when a trajectory is present', () => {
    const withTraj = {
      ...base,
      trajectory: [TRAJ_STEP],
      verifiedOutcome: 'success',
    } as unknown as ScoredStrategyItem;
    expect(renderStrategyNote(withTraj)).toBe(
      '[DO] commit on dated conflicts — applies when: knowledge-update questions. ' +
        'Prefer the latest dated value. [past tool path: web_search(ok), verified success]',
    );
  });
});

// ── the READ GATE: projection is byte-identical when the flag is off ──────

describe('trajectory read gate (byte-identical serving when off)', () => {
  const BOTH_ON = { STRATEGY_MEMORY_ENABLED: '1', STRATEGY_RETRIEVAL_ENABLED: '1' };

  it('OFF: the serving SELECT never names the trajectory columns', async () => {
    const calls: QueryCall[] = [];
    const svc = new StrategyMemoryService(
      // Model reality: with the flag off the DB would not return trajectory
      // columns, so the stub returns a plain row (no trajectory).
      stubSurreal(
        (sql) =>
          sql.includes('FROM strategy_memory') ? [[trajRow({ trajectory: undefined })]] : [[]],
        calls,
      ),
      stubEmbedder({ q: [1, 0] }),
      stubConfig(BOTH_ON), // STRATEGY_TRAJECTORIES_ENABLED unset → off
    );
    const out = await svc.retrieve('c1', 'q');
    const serving = calls.find((c) => c.sql.includes('FROM strategy_memory'));
    expect(serving?.sql).not.toContain('trajectory');
    expect(serving?.sql).not.toContain('verifiedOutcome');
    // Item is byte-identical to pre-0098 — no experience fields, classic note.
    expect(out[0]!.trajectory).toBeUndefined();
    expect(renderStrategyNote(out[0]!)).not.toContain('past tool path');
  });

  it('ON: the serving SELECT names the trajectory columns and they map through', async () => {
    const calls: QueryCall[] = [];
    const svc = new StrategyMemoryService(
      stubSurreal((sql) => (sql.includes('FROM strategy_memory') ? [[trajRow()]] : [[]]), calls),
      stubEmbedder({ q: [1, 0] }),
      stubConfig({ ...BOTH_ON, STRATEGY_TRAJECTORIES_ENABLED: '1' }),
    );
    const out = await svc.retrieve('c1', 'q');
    const serving = calls.find((c) => c.sql.includes('FROM strategy_memory'));
    expect(serving?.sql).toContain('trajectory');
    expect(serving?.sql).toContain('verifiedOutcome');
    expect(out[0]!.trajectory).toEqual([TRAJ_STEP]);
    expect(out[0]!.verifiedOutcome).toBe('success');
    expect(renderStrategyNote(out[0]!)).toContain(
      '[past tool path: web_search(ok), verified success]',
    );
  });
});
