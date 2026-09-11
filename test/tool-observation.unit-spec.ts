/**
 * Unit coverage for the 0111 tool-observation seam:
 *   * ToolObservationService.record — master-flag guard, fire-and-forget
 *     insert shape, and the CONTENT-FREE invariant (no raw arg/result
 *     substring survives into the row when TOOL_OBSERVATION_CONTENT is
 *     off);
 *   * contentExcerpt opt-in gating + sanitization + cap;
 *   * verifyRef — tenant-pinned lookup, malformed refs read as absent;
 *   * OutcomePruneService tool_observation leg — query shape + gating.
 */
import {
  ToolObservationService,
  shapeObservationRow,
  TOOL_OBSERVATION_EXCERPT_CAP,
} from '../src/outcomes/tool-observation.service';
import {
  OutcomePruneService,
  TOOL_OBSERVATION_PRUNE_BATCH_QUERY,
} from '../src/outcomes/outcome-prune.service';
import { digestPayload } from '../src/common/payload-digest';
import type { SurrealService } from '../src/db/surreal.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

interface CapturedQuery {
  sql: string;
  params: Record<string, unknown>;
}

function makeSurreal(captured: CapturedQuery[], results: unknown[][] = []) {
  let call = 0;
  const db = {
    query: async (sql: string, params: Record<string, unknown>) => {
      captured.push({ sql, params });
      return [results[call++] ?? []];
    },
  };
  return {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ToolObservationService.record', () => {
  beforeEach(() => {
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    delete process.env.TOOL_OBSERVATION_CONTENT;
  });
  afterAll(() => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.TOOL_OBSERVATION_CONTENT;
  });

  it('master flag off ⇒ no insert at all', async () => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    const captured: CapturedQuery[] = [];
    const svc = new ToolObservationService(makeSurreal(captured));
    svc.record('co_x', { tool: 't', args: { a: 1 }, result: 'r', ok: true, durationMs: 5 });
    await flush();
    expect(captured).toEqual([]);
  });

  it('inserts one content-free row: digests present, raw payloads absent', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new ToolObservationService(makeSurreal(captured));
    const secretArgs = { apiKey: 'sk-SECRET-ARG-VALUE', query: 'who is the CFO' };
    const secretResult = { text: 'THE-CFO-IS-JANE-DOE', token: 'tok-RESULT-SECRET' };
    svc.record('co_x', {
      tool: 'search_knowledge',
      args: secretArgs,
      result: secretResult,
      ok: true,
      durationMs: 42.7,
      requestId: 'req-1',
    });
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toBe('INSERT INTO tool_observation $row');
    const row = captured[0]!.params.row as Record<string, unknown>;
    expect(row.tool).toBe('search_knowledge');
    expect(row.argsDigest).toBe(digestPayload(secretArgs));
    expect(row.resultDigest).toBe(digestPayload(secretResult));
    expect(row.ok).toBe(true);
    expect(row.durationMs).toBe(43);
    expect(row.requestId).toBe('req-1');
    // CONTENT-FREE invariant: no raw arg/result substring survives.
    const serialized = JSON.stringify(row);
    for (const leak of [
      'sk-SECRET-ARG-VALUE',
      'who is the CFO',
      'THE-CFO-IS-JANE-DOE',
      'tok-RESULT-SECRET',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    expect(row.contentExcerpt).toBeUndefined();
  });

  it('a failed insert warns and never throws (fire-and-forget)', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const svc = new ToolObservationService(surreal);
    expect(() => svc.record('co_x', { tool: 't', ok: false, durationMs: 1 })).not.toThrow();
    await flush();
  });
});

describe('shapeObservationRow — excerpt gating + caps', () => {
  beforeEach(() => {
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    delete process.env.TOOL_OBSERVATION_CONTENT;
  });
  afterAll(() => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.TOOL_OBSERVATION_CONTENT;
  });

  it('excerpt appears ONLY under TOOL_OBSERVATION_CONTENT', () => {
    const input = { tool: 't', result: 'visible result text', ok: true, durationMs: 1 };
    expect(shapeObservationRow(input).contentExcerpt).toBeUndefined();
    process.env.TOOL_OBSERVATION_CONTENT = '1';
    expect(shapeObservationRow(input).contentExcerpt).toContain('visible result text');
  });

  it('excerpt is sanitized and capped at 512 chars', () => {
    process.env.TOOL_OBSERVATION_CONTENT = '1';
    const noisy = `bad\u0000chars\u200b here ${'x'.repeat(1000)}`;
    const excerpt = shapeObservationRow({
      tool: 't',
      result: noisy,
      ok: true,
      durationMs: 1,
    }).contentExcerpt!;
    expect(excerpt.length).toBeLessThanOrEqual(TOOL_OBSERVATION_EXCERPT_CAP);
    // Invisibles stripped (sanitizePackText), layout collapsed.
    expect(excerpt).not.toContain('\u200b');
    expect(excerpt).toContain('chars here');
  });

  it('caps tool name and id fields; clamps durationMs', () => {
    const row = shapeObservationRow({
      tool: 'x'.repeat(300),
      ok: true,
      durationMs: -5,
      requestId: 'r'.repeat(300),
      packId: 'p'.repeat(300),
      installId: 'i'.repeat(300),
    });
    expect(row.tool.length).toBeLessThanOrEqual(80);
    expect(row.requestId!.length).toBeLessThanOrEqual(128);
    expect(row.packId!.length).toBeLessThanOrEqual(128);
    expect(row.installId!.length).toBeLessThanOrEqual(128);
    expect(row.durationMs).toBe(0);
  });
});

describe('ToolObservationService.verifyRef', () => {
  beforeEach(() => {
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
  });

  it('resolves an in-tenant row to its content-free note material', async () => {
    const captured: CapturedQuery[] = [];
    const created = new Date('2026-08-26T10:00:00.000Z');
    const svc = new ToolObservationService(
      makeSurreal(captured, [[{ tool: 'search_knowledge', createdAt: created }]]),
    );
    const out = await svc.verifyRef('co_x', 'tool_observation:abc123');
    expect(out).toEqual({ tool: 'search_knowledge', createdAt: '2026-08-26T10:00:00.000Z' });
    expect(captured[0]!.sql).toContain("type::record('tool_observation', $tail)");
    expect(captured[0]!.params.tail).toBe('abc123');
  });

  it('rejects wrong-prefix, empty-tail, and unknown refs', async () => {
    const svc = new ToolObservationService(makeSurreal([], [[]]));
    expect(await svc.verifyRef('co_x', 'knowledge_fact:abc')).toBeNull();
    expect(await svc.verifyRef('co_x', 'tool_observation:')).toBeNull();
    expect(await svc.verifyRef('co_x', 'tool_observation:missing')).toBeNull();
  });
});

describe('OutcomePruneService — tool_observation leg', () => {
  const apiKeys = (ids: string[]) => ({ fanOutRoster: () => ids }) as unknown as ApiKeyService;

  beforeEach(() => {
    // The decision leg (0119) is default-on; this suite isolates the
    // other legs, so it says so rather than relying on a default.
    process.env.OUTCOME_DECISION_CAPTURE = '0';
  });

  afterEach(() => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    delete process.env.OUTCOME_DECISION_CAPTURE;
    delete process.env.TOOL_OBSERVATION_RETENTION_DAYS;
  });

  it('prune query is the bounded DELETE-subquery shape', () => {
    expect(TOOL_OBSERVATION_PRUNE_BATCH_QUERY).toBe(
      'DELETE (SELECT id FROM tool_observation WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE',
    );
  });

  it('runNightly runs the observation leg without the outcome master', async () => {
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    const captured: CapturedQuery[] = [];
    const svc = new OutcomePruneService(makeSurreal(captured, [[]]), apiKeys(['co_x']));
    expect(await svc.runNightly()).toEqual({ tenants: 1, pruned: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toBe(TOOL_OBSERVATION_PRUNE_BATCH_QUERY);
    expect(captured[0]!.params.cutoff).toBeInstanceOf(Date);
  });

  it('both flags off ⇒ no queries at all', async () => {
    const captured: CapturedQuery[] = [];
    const svc = new OutcomePruneService(makeSurreal(captured), apiKeys(['co_x']));
    expect(await svc.runNightly()).toEqual({ tenants: 0, pruned: 0 });
    expect(captured).toEqual([]);
  });

  it('honors TOOL_OBSERVATION_RETENTION_DAYS for the cutoff', async () => {
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    process.env.TOOL_OBSERVATION_RETENTION_DAYS = '7';
    const captured: CapturedQuery[] = [];
    const svc = new OutcomePruneService(makeSurreal(captured, [[]]), apiKeys(['co_x']));
    await svc.runNightly();
    const cutoff = captured[0]!.params.cutoff as Date;
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
