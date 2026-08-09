import {
  extractArcTopic,
  pickArcBeats,
  renderArcLines,
  type ArcBeat,
} from '../src/synthesize/query-arc';
import { QueryArcService } from '../src/synthesize/query-arc.service';
import { wantsInsightEvidence } from '../src/synthesize/evidence-gates';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
  type RetrievalProfile,
} from '../src/search/retrieval-profile';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';

/**
 * V10 §4 — query-time arc assembly (insightEvidence='query_arc'). The
 * v9arcs verdict: write-time arcs are coverage-thin by construction
 * (only fact-dense entities clear the composer floor) and stored
 * topics are decided blind to the questions. Query-time inverts it:
 * the asked topic scans the atomic fact record coverage-first and the
 * most topical beats emit as one chronological dated record under the
 * insight slot.
 */

describe('extractArcTopic', () => {
  it('strips summary scaffolding down to the topic', () => {
    expect(
      extractArcTopic('Give me a comprehensive summary of the parser project'),
    ).toBe('parser project');
    expect(extractArcTopic('How has the database migration progressed over time?')).toBe(
      'database migration',
    );
    expect(extractArcTopic('What happened with the CORS errors?')).toBe(
      'CORS errors',
    );
  });

  it('falls back to the whole question when the residue is too thin', () => {
    expect(extractArcTopic('Summarize?')).toBe('Summarize?');
  });
});

describe('pickArcBeats', () => {
  const beat = (
    object: string,
    validFrom: string,
    opts: { sim?: number; lex?: number } = {},
  ): ArcBeat => ({ object, validFrom, ...opts });

  it('keeps the most topical beats, then restores chronology', () => {
    const beats = [
      beat('late but weak', '2026-03-01', { sim: 0.4 }),
      beat('early and lexical', '2026-01-01', { lex: 2 }),
      beat('mid and strong-dense', '2026-02-01', { sim: 0.9 }),
    ];
    const picked = pickArcBeats(beats, 2);
    expect(picked.map((b) => b.object)).toEqual([
      'early and lexical',
      'mid and strong-dense',
    ]);
  });

  it('caps at the beat budget', () => {
    const beats = Array.from({ length: 30 }, (_, i) =>
      beat(`b${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, { lex: 1 }),
    );
    expect(pickArcBeats(beats).length).toBe(12);
  });
});

describe('renderArcLines', () => {
  it('renders dated beat lines and drops empties', () => {
    const lines = renderArcLines([
      { object: 'started the migration', validFrom: '2026-01-02T10:00:00Z' },
      { object: '   ', validFrom: '2026-01-03T10:00:00Z' },
    ]);
    expect(lines).toEqual(['- [2026-01-02] started the migration']);
  });

  it('caps runaway beat text', () => {
    const [line] = renderArcLines([
      { object: 'x'.repeat(500), validFrom: '2026-01-02' },
    ]);
    expect(line.length).toBeLessThan(230);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('QueryArcService', () => {
  function makeService(rows: {
    dense: Array<Record<string, unknown>>;
    bm25: Array<Record<string, unknown>>;
    capture?: string[];
  }): QueryArcService {
    const surreal = {
      withCompany: async (
        _c: string,
        fn: (db: unknown) => Promise<unknown>,
      ) => {
        let call = 0;
        return fn({
          query: async (sql: string) => {
            rows.capture?.push(sql);
            call += 1;
            return [call === 1 ? rows.dense : rows.bm25];
          },
        });
      },
    } as unknown as SurrealService;
    const embedder = {
      embed: async () => [0.1, 0.2],
    } as unknown as EmbedderService;
    return new QueryArcService(surreal, embedder);
  }

  it('emits chronological dated beats from the merged scan', async () => {
    const svc = makeService({
      dense: [
        {
          id: 'knowledge_fact:a',
          object: 'refactored the parser',
          validFrom: '2026-02-01T09:00:00Z',
          score: 0.8,
        },
      ],
      bm25: [
        {
          id: 'knowledge_fact:b',
          object: 'started the parser project',
          validFrom: '2026-01-05T09:00:00Z',
          score: 3,
        },
      ],
    });
    const lines = await svc.arcLines({
      companyId: 'c1',
      query: 'Summarize the parser project',
      callerScopes: ['brain:read'],
    });
    expect(lines).toEqual([
      '- [2026-01-05] started the parser project',
      '- [2026-02-01] refactored the parser',
    ]);
  });

  it('excludes stored insight rows and closed lifecycle rows in SQL', async () => {
    const capture: string[] = [];
    const svc = makeService({ dense: [], bm25: [], capture });
    await svc.arcLines({
      companyId: 'c1',
      query: 'Summarize the parser project',
      callerScopes: [],
    });
    for (const sql of capture) {
      expect(sql).toContain("string::starts_with(predicate, 'summary_')");
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain('retractedAt IS NONE');
      // PII fence for callers without brain:read_pii; fail-closed user scope.
      expect(sql).toContain('piiClass IS NONE');
      expect(sql).toContain('userId IS NONE');
    }
  });

  it('degrades to [] on failure', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const embedder = { embed: async () => [0.1] } as unknown as EmbedderService;
    const svc = new QueryArcService(surreal, embedder);
    await expect(
      svc.arcLines({ companyId: 'c1', query: 'q', callerScopes: [] }),
    ).resolves.toEqual([]);
  });

  it('renders ISO days and sorts chronologically when the driver returns Date objects', async () => {
    // The SDK decodes datetime columns to JS Dates (CBOR). String(Date)
    // would render '[Sat Aug 09]' and sort alphabetically by weekday —
    // the regression this case pins.
    const svc = makeService({
      dense: [
        {
          id: 'knowledge_fact:late',
          object: 'wrapped up the parser project',
          validFrom: new Date('2026-02-01T09:00:00Z'),
          score: 0.8,
        },
        {
          id: 'knowledge_fact:early',
          object: 'started the parser project',
          validFrom: new Date('2026-01-05T09:00:00Z'),
          score: 0.75,
        },
      ],
      bm25: [],
    });
    const lines = await svc.arcLines({
      companyId: 'c1',
      query: 'Summarize the parser project',
      callerScopes: ['brain:read'],
    });
    expect(lines).toEqual([
      '- [2026-01-05] started the parser project',
      '- [2026-02-01] wrapped up the parser project',
    ]);
  });

  it('hnsw tuning emits the KNN dense leg with the FULL gate stack intact', async () => {
    // The recall trap of the KNN rewrite: SurrealDB applies WHERE after
    // the approximate walk, so every gate must survive into the KNN SQL
    // and the overfetch must widen the walk (k=200 × 4 × the lane's own
    // ×2 gate factor = 1600).
    const capture: string[] = [];
    const svc = makeService({ dense: [], bm25: [], capture });
    await svc.arcLines({
      companyId: 'c1',
      query: 'Summarize the parser project',
      callerScopes: [],
      scan: { mode: 'hnsw', ef: 400, overfetch: 4 },
    });
    const knn = capture[0];
    expect(knn).toContain('embedding <|1600,1600|> $q');
    expect(knn).toContain("string::starts_with(predicate, 'summary_')");
    expect(knn).toContain("status = 'active'");
    expect(knn).toContain('retractedAt IS NONE');
    expect(knn).toContain('piiClass IS NONE');
    expect(knn).toContain('userId IS NONE');
    // Empty KNN pool → the brute fallback ran before the BM25 leg.
    expect(capture[1]).toContain('embedding != NONE');
    expect(capture[2]).toContain('searchHaystack @1@ $topic');
  });
});

describe('query_arc gating and prompt header', () => {
  const profileWith = (mode: RetrievalProfile['insightEvidence']) =>
    ({
      ...resolveRetrievalProfile({} as NodeJS.ProcessEnv),
      insightEvidence: mode,
    }) as RetrievalProfile;

  it('wantsInsightEvidence admits query_arc on the paying lanes only', () => {
    expect(wantsInsightEvidence(profileWith('query_arc'), 'summary')).toBe(true);
    expect(wantsInsightEvidence(profileWith('query_arc'), 'enumeration')).toBe(
      true,
    );
    expect(wantsInsightEvidence(profileWith('query_arc'), 'temporal')).toBe(
      false,
    );
    expect(wantsInsightEvidence(profileWith('query_arc'), null)).toBe(false);
    expect(wantsInsightEvidence(profileWith('off'), 'summary')).toBe(false);
    expect(wantsInsightEvidence(profileWith('routed'), 'summary')).toBe(true);
  });

  it('arcInsights swaps the insight-section header', () => {
    const base = {
      query: 'Summarize the parser project',
      factLines: ['[knowledge_fact:f1] Alex — work: parser'],
      insightLines: ['- [2026-01-05] started the parser project'],
      answerLang: null,
    };
    const arc = buildGeneratorUserMessage({ ...base, arcInsights: true });
    expect(arc).toContain('Topic record (dated beats');
    expect(arc).not.toContain('Derived insights');
    const stored = buildGeneratorUserMessage(base);
    expect(stored).toContain('Derived insights');
    expect(stored).not.toContain('Topic record');
  });
});

describe('RETRIEVAL_INSIGHT_EVIDENCE query_arc profile point', () => {
  it('round-trips from env; garbage rejects to off; overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_INSIGHT_EVIDENCE: 'query_arc',
      } as NodeJS.ProcessEnv).insightEvidence,
    ).toBe('query_arc');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_INSIGHT_EVIDENCE: 'arc',
      } as NodeJS.ProcessEnv).insightEvidence,
    ).toBe('off');
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { insightEvidence: 'query_arc' },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).insightEvidence).toBe(
      'query_arc',
    );
    expect(resolveRetrievalProfileFor('other', env).insightEvidence).toBe('off');
  });
});
