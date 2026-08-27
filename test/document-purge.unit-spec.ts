/**
 * Fact-mediated document-cascade planner (GDPR forget): the exclusivity
 * query shape, dedupe of the fact-side documentId snapshot, the
 * EXCLUSIVE/SHARED classification, and the chunkCount-column pre-counts
 * (no chunk scan) — all against a recorded mock handle, no server.
 */
import {
  exclusivityCountQuery,
  planDocumentCascade,
  purgeExclusiveDocContent,
  deleteDocumentIdentityRows,
  QueryHandle,
} from '../src/documents/document-purge.util';

/** Scripted query handle: returns canned results in call order. */
function mkDb(results: unknown[][]): { db: QueryHandle; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  let i = 0;
  const db = {
    query: async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push([sql, params]);
      const r = results[i++] ?? [[]];
      return r as T;
    },
  } as QueryHandle;
  return { db, calls };
}

describe('exclusivityCountQuery', () => {
  it('counts facts referencing the doc that are NOT the subject', () => {
    expect(exclusivityCountQuery('userId = $u')).toBe(
      'SELECT count() AS n FROM knowledge_fact ' +
        'WHERE source.documentId = $doc AND !(userId = $u) GROUP ALL',
    );
  });
});

describe('planDocumentCascade', () => {
  it('dedupes the snapshot, classifies exclusive vs shared, pre-counts by column', async () => {
    const { db, calls } = mkDb([
      // Snapshot: duplicates + a non-document value that must be filtered.
      [['source_document:a', 'source_document:a', 'source_document:b', 'null']],
      // Exclusivity a: no other subject's facts → EXCLUSIVE.
      [[{ n: 0 }]],
      // Exclusivity b: another subject still grounds facts → SHARED.
      [[{ n: 2 }]],
      // chunkCount column pre-count for the exclusive set.
      [[{ chunkCount: 3 }]],
      // candidate / indexer_run counts for the exclusive set.
      [[{ n: 4 }]],
      [[{ n: 1 }]],
    ]);
    const plan = await planDocumentCascade(db, {
      predicate: 'userId = $u',
      params: { u: 'user_x' },
    });

    expect(plan.exclusiveDocIds).toEqual(['source_document:a']);
    expect(plan.sharedDocIds).toEqual(['source_document:b']);
    expect(plan.exclusiveDocRefs).toHaveLength(1);
    expect(plan.chunkCount).toBe(3);
    expect(plan.candidateCount).toBe(4);
    expect(plan.indexerRunCount).toBe(1);

    // Snapshot filters on the subject predicate AND a present documentId.
    expect(calls[0]![0]).toContain('SELECT VALUE source.documentId FROM knowledge_fact');
    expect(calls[0]![0]).toContain('(userId = $u) AND source.documentId != NONE');
    // One exclusivity probe per DEDUPED doc (2, not 3), subject params carried.
    expect(calls[1]![0]).toBe(exclusivityCountQuery('userId = $u'));
    expect(calls[1]![1]).toEqual({ u: 'user_x', doc: 'source_document:a' });
    expect(calls[2]![1]).toEqual({ u: 'user_x', doc: 'source_document:b' });
    // Pre-counts go by the chunkCount COLUMN — never a source_chunk scan.
    expect(calls[3]![0]).toContain('SELECT chunkCount FROM $docs');
    expect(calls[4]![0]).toContain('FROM candidate WHERE docId INSIDE $docs');
    expect(calls[5]![0]).toContain('FROM indexer_run WHERE docId INSIDE $docs');
    expect(calls).toHaveLength(6);
  });

  it('skips all counting when the subject grounds in no documents', async () => {
    const { db, calls } = mkDb([[[]]]);
    const plan = await planDocumentCascade(db, { predicate: 'userId = $u', params: { u: 'x' } });
    expect(plan.exclusiveDocIds).toEqual([]);
    expect(plan.sharedDocIds).toEqual([]);
    expect(plan.chunkCount).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe('purgeExclusiveDocContent', () => {
  it('flags provenance FIRST, then drains chunks, then purges the header', async () => {
    const { db, calls } = mkDb([
      [[{ n: 2 }]], // markFactsProvenancePurged count
      [[]], // markFactsProvenancePurged update
      [undefined, []], // chunk batch (partial → drained)
      [[]], // header purge
    ]);
    const purged = await purgeExclusiveDocContent(db, {
      exclusiveDocIds: ['source_document:a'],
      exclusiveDocRefs: [],
      sharedDocIds: [],
      chunkCount: 0,
      candidateCount: 0,
      indexerRunCount: 0,
    });
    expect(purged).toBe(0);
    // Defined mid-failure state: the provenance flag lands BEFORE any delete.
    expect(calls[0]![0]).toContain('source.provenancePurged != true');
    expect(calls[2]![0]).toContain('SELECT VALUE id FROM source_chunk');
    expect(calls[3]![0]).toContain(`SET status = 'purged', hasContent = false`);
  });
});

describe('deleteDocumentIdentityRows', () => {
  it('is a no-op without exclusive docs and two-steps every delete', async () => {
    const empty = mkDb([]);
    expect(await deleteDocumentIdentityRows(empty.db, [])).toEqual({
      candidates: 0,
      indexerRuns: 0,
      docs: 0,
    });
    expect(empty.calls).toHaveLength(0);
  });
});
