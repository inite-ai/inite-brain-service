/**
 * Debug traces (X-Brain-Debug: 1 → `__trace`, and the tenant's ring
 * buffer behind GET /v1/admin/traces[/:requestId]) reach brain:admin
 * callers, so they carry no memory content a read fence would hide:
 *
 *  - the search legs trace their hits BEFORE the row policy (requiresScope,
 *    ABAC) runs; those artifacts carry ids, predicates and scores, never a
 *    fact's value, an entity's name or a segment's text;
 *  - a user-bound request's trace is that user's: another user's key and a
 *    tenant-wide key do not see it in the buffer, and it is not persisted.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DebugTraceSnapshot } from '../src/common/debug-trace-core';
import { TraceBufferService } from '../src/common/trace-buffer.service';

const SEARCH_DIR = join(__dirname, '..', 'src', 'search');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** Every `traceArtifact(...)` call's argument text, balanced on parentheses. */
function traceCalls(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf('traceArtifact(');
  while (at !== -1) {
    let depth = 0;
    let end = at + 'traceArtifact'.length;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push(src.slice(at, end + 1));
    at = src.indexOf('traceArtifact(', end);
  }
  return out;
}

describe('search trace artifacts carry no memory content', () => {
  const calls = sourceFiles(SEARCH_DIR).flatMap((file) =>
    traceCalls(readFileSync(file, 'utf8')).map((call) => ({ file, call })),
  );

  it('finds the search trace sites (the scan is not vacuous)', () => {
    const names = calls.map((c) => /traceArtifact\(\s*'([^']+)'/.exec(c.call)?.[1]);
    expect(names).toEqual(
      expect.arrayContaining([
        'search.vector_hits',
        'search.lexical_hits',
        'search.relation_hits',
        'search.segment_hits',
        'search.entity_expansion',
      ]),
    );
  });

  it.each(['.object', 'canonicalName', '.text', 'expansionQuery'])(
    'no search trace artifact reads %s',
    (needle) => {
      const offenders = calls.filter((c) => c.call.includes(needle)).map((c) => c.call);
      expect(offenders).toEqual([]);
    },
  );
});

describe('entity-resolution trace artifacts carry the candidate as an id, not its memory', () => {
  const calls = traceCalls(
    readFileSync(join(__dirname, '..', 'src', 'ingest', 'entity-resolver.service.ts'), 'utf8'),
  );

  it('ingest.entity.judge / same_name name neither the candidate nor its facts', () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).not.toContain('canonicalName');
      expect(call).not.toMatch(/\bexistingFacts\s*[,}]/);
    }
  });
});

function snap(requestId: string, userId?: string): DebugTraceSnapshot {
  return {
    requestId,
    ts: new Date().toISOString(),
    method: 'POST',
    path: '/v1/mentions',
    status: 201,
    durationMs: 3,
    companyId: 'lab',
    ...(userId ? { userId } : {}),
    spans: [],
    artifacts: [
      { name: 'ingest.mention.input', ts: 0, value: { text: `${requestId} words` }, sizeBytes: 16 },
    ],
  };
}

describe('the trace buffer is fenced per end user', () => {
  const buffer = new TraceBufferService();
  buffer.add(snap('tenantwide'));
  buffer.add(snap('fromA', 'userA'));
  buffer.add(snap('fromB', 'userB'));

  it("a user-bound viewer lists and opens its own traces only, never another user's", async () => {
    expect(buffer.list('lab', { userId: 'userA' }).map((t) => t.requestId)).toEqual(['fromA']);
    expect(await buffer.get('fromB', 'lab', { userId: 'userA' })).toBeUndefined();
    expect((await buffer.get('fromA', 'lab', { userId: 'userA' }))?.requestId).toBe('fromA');
  });

  it("a tenant-wide viewer does not see a user-bound request's trace", async () => {
    expect(buffer.list('lab').map((t) => t.requestId)).toEqual(['tenantwide']);
    expect(await buffer.get('fromA', 'lab')).toBeUndefined();
  });

  it('a user-bound trace is never written to debug_trace', async () => {
    const writes: string[] = [];
    const surreal = {
      withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
        fn({
          query: async (_sql: string, vars?: { requestId?: string }) => {
            if (vars?.requestId) writes.push(vars.requestId);
            return [[]];
          },
        }),
    };
    const config = { get: (k: string, d?: string) => (k === 'DEBUG_TRACE_PERSIST' ? '1' : d) };
    const persisting = new TraceBufferService(config as never, surreal as never);
    persisting.add(snap('fromA', 'userA'));
    persisting.add(snap('tenantwide'));
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual(['tenantwide']);
  });
});
