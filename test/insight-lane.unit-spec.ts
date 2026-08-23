import type { Surreal } from 'surrealdb';
import {
  runInsightLegs,
  INSIGHT_TOP_K,
} from '../src/search/internals/insight-leg';
import { buildBaseWhere } from '../src/search/internals/where-builder';
import { InsightLaneService } from '../src/synthesize/insight-lane.service';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import type { SearchDto } from '../src/search/dto/search.dto';

/**
 * V8 §1 — the qualified insight lane. The naive cut (aggregates ride
 * the fact legs) is a measured null: MS tie, BEAM −2.0pp, summarization
 * DOWN — insight rows displace atomic facts inside the fact budget.
 * The qualified design: fact legs EXCLUDE insight rows under
 * insightEvidence='routed'; summary/enumeration questions retrieve them
 * as their own convex-fused pool under a separate prompt slot.
 */
function recordingDb(perQuery: Record<string, unknown[]>): {
  db: Pick<Surreal, 'query'>;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      for (const [marker, rows] of Object.entries(perQuery)) {
        if (sql.includes(marker)) return [rows];
      }
      return [[]];
    },
  } as Pick<Surreal, 'query'>;
  return { db, queries };
}

const AGG = {
  id: 'knowledge_fact:agg1',
  predicate: 'aggregate_hobbies',
  object: 'Caroline has taken up pottery, bouldering and archery this year',
  validFrom: '2023-05-01T10:00:00Z',
  score: 0.9,
};

describe('runInsightLegs', () => {
  it('retrieves ONLY insight rows, world-pinned, as pseudo-FactRows', async () => {
    const { db, queries } = recordingDb({
      'vector::similarity::cosine': [AGG],
      'search::score(1)': [{ ...AGG, score: 3.2 }],
    });
    const { vectorRows, lexicalRows } = await runInsightLegs({
      db,
      queryText: 'hobbies',
      queryVector: [1, 0],
      fetchK: 12,
      callerScopes: ['brain:read'],
      derivedVersion: 'wd-v2',
    });
    expect(vectorRows).toHaveLength(1);
    expect(lexicalRows).toHaveLength(1);
    expect(vectorRows[0]!.predicate).toBe('aggregate_hobbies');
    expect(vectorRows[0]!.simScore).toBe(0.9);
    expect(lexicalRows[0]!.bm25Score).toBe(3.2);
    expect(vectorRows[0]!.source.vertical).toBe('insight');
    for (const q of queries) {
      // The pool filter — aggregates by recorder, summaries by prefix.
      expect(q.sql).toContain('source.recorder = $insightRecorder');
      expect(q.sql).toContain("string::starts_with(predicate, 'summary_')");
      expect(q.params?.insightRecorder).toBe('aggregate-composer-v1');
      // Same shared fences as every leg.
      expect(q.sql).toContain('AND piiClass IS NONE');
      expect(q.sql).toContain('AND userId IS NONE');
      // Derived-world pin: batch aggregates must not leak across worlds.
      expect(q.sql).toContain('AND derivedVersion = $derivedVersion');
      expect(q.params?.derivedVersion).toBe('wd-v2');
    }
  });

  it('legacy world (null pin) pins to derivedVersion IS NONE', async () => {
    const { db, queries } = recordingDb({});
    await runInsightLegs({
      db,
      queryText: 'hobbies',
      queryVector: null,
      fetchK: 12,
      callerScopes: [],
      derivedVersion: null,
    });
    expect(queries).toHaveLength(1); // no vector → BM25 only
    expect(queries[0]!.sql).toContain('AND derivedVersion IS NONE');
  });

  it('budgets long insight text at a word boundary', async () => {
    const long = { ...AGG, object: `${'word '.repeat(300)}tail` };
    const { db } = recordingDb({ 'vector::similarity::cosine': [long] });
    const { vectorRows } = await runInsightLegs({
      db,
      queryText: 'hobbies',
      queryVector: [1, 0],
      fetchK: 12,
      callerScopes: [],
      derivedVersion: 'wd-v2',
    });
    expect(vectorRows[0]!.object.length).toBeLessThan(820);
    expect(vectorRows[0]!.object.endsWith('[…]')).toBe(true);
  });
});

describe('buildBaseWhere insight arbitration', () => {
  const base = {
    dto: { query: 'q' } as SearchDto,
    asOf: null,
    includeRetracted: false,
    includeContested: false,
    derivedVersion: 'wd-v2',
  };

  it('excludeInsightRows adds both exclusion idioms', () => {
    const { sql, params } = buildBaseWhere({
      ...base,
      excludeInsightRows: true,
    });
    expect(sql).toContain('source.recorder != $insightRecorder');
    expect(sql).toContain("!string::starts_with(predicate, 'summary_')");
    expect(params.insightRecorder).toBe('aggregate-composer-v1');
  });

  it('default (off) is byte-identical to the pre-V8 clause set', () => {
    const off = buildBaseWhere({ ...base });
    expect(off.sql).not.toContain('insightRecorder');
    expect(off.sql).not.toContain('summary_');
  });
});

describe('InsightLaneService', () => {
  const embedder = { embed: async () => [1, 0] } as any;
  const readPin = {
    resolve: async () => 'wd-v2',
    resolveRead: async () => 'wd-v2',
  } as any;

  function surrealWith(rows: unknown[]): any {
    return {
      withCompany: async (_c: string, fn: (db: any) => Promise<any>) =>
        fn({
          query: async (sql: string) =>
            sql.includes('vector::similarity::cosine') ? [rows] : [[]],
        }),
    };
  }

  it('fuses, caps at INSIGHT_TOP_K and renders dated lines', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `knowledge_fact:a${i}`,
      predicate: 'aggregate_x',
      object: `insight number ${i}`,
      validFrom: '2023-05-01T10:00:00Z',
      score: 1 - i / 10,
    }));
    const lane = new InsightLaneService(surrealWith(rows), embedder, readPin);
    const lines = await lane.insightLines({
      companyId: 'co',
      query: 'summarize hobbies',
      callerScopes: ['brain:read'],
    });
    expect(lines).toHaveLength(INSIGHT_TOP_K);
    expect(lines[0]).toBe('- insight number 0 (as of 2023-05-01)');
  });

  it('degrades to [] on any failure', async () => {
    const broken = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as any;
    const lane = new InsightLaneService(broken, embedder, readPin);
    await expect(
      lane.insightLines({ companyId: 'co', query: 'q', callerScopes: [] }),
    ).resolves.toEqual([]);
  });
});

describe('RETRIEVAL_INSIGHT_EVIDENCE profile point', () => {
  it('defaults off; routed round-trips; garbage rejects to off', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).insightEvidence,
    ).toBe('off');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_INSIGHT_EVIDENCE: 'routed',
      } as NodeJS.ProcessEnv).insightEvidence,
    ).toBe('routed');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_INSIGHT_EVIDENCE: 'sometimes',
      } as NodeJS.ProcessEnv).insightEvidence,
    ).toBe('off');
  });

  it('overlays per tenant via RETRIEVAL_PROFILE_OVERRIDES', () => {
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { insightEvidence: 'routed' },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).insightEvidence).toBe(
      'routed',
    );
    expect(resolveRetrievalProfileFor('other', env).insightEvidence).toBe(
      'off',
    );
  });
});

describe('generator prompt insight section', () => {
  const base = {
    query: 'summarize my year',
    factLines: ['- fact one'],
    answerLang: null,
  };

  it('absent insightLines → byte-identical prompt (no drift)', () => {
    expect(buildGeneratorUserMessage({ ...base })).toBe(
      buildGeneratorUserMessage({ ...base, insightLines: [] }),
    );
  });

  it('renders insights as their own section after transcripts', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      transcriptLines: ['[t] hello'],
      insightLines: ['- big picture (as of 2023-05-01)'],
    });
    expect(msg).toContain('Derived insights');
    expect(msg.indexOf('Transcript excerpts')).toBeLessThan(
      msg.indexOf('Derived insights'),
    );
  });
});
