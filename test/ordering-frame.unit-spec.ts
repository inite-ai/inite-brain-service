import {
  dedupeMentionLines,
  extractOrderingTopic,
  topicTerms,
} from '../src/synthesize/mention-scan';
import { MentionScanService } from '../src/synthesize/mention-scan.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import {
  ENUMERATION_LANE_INSTRUCTION,
  ORDERING_LANE_INSTRUCTION,
} from '../src/synthesize/answer-router';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V10 §3 — ordering frame + aspect dedup. The v9scan verdict: the
 * mention record fired (40/40 EO predictions changed) but the score
 * didn't move, because ordering questions ride the enumeration frame —
 * "enumerate every matching item with its date; a partial list is a
 * wrong answer" — which fights the golds' exact-N constraint and
 * aspect-label granularity. Under orderingFrame the generator gets an
 * order-of-mention frame instead, and near-duplicate aspect mentions
 * collapse inside the record.
 */

describe('dedupeMentionLines', () => {
  it('collapses near-duplicate aspects, keeping the earliest line', () => {
    const lines = [
      '[2026-01-02] alex: struggling with CORS errors on the fetch layer',
      '[2026-01-09] alex: still fighting those CORS errors in the fetch layer',
      '[2026-01-15] alex: switched the weather widget to OpenWeather API',
    ];
    const out = dedupeMentionLines(lines);
    expect(out).toEqual([lines[0], lines[2]]);
  });

  it('keeps distinct aspects even on shared topic words', () => {
    const lines = [
      '[2026-01-02] alex: designing the parser grammar for the query language',
      '[2026-01-05] alex: benchmarking the parser on long documents',
    ];
    expect(dedupeMentionLines(lines)).toEqual(lines);
  });

  it('never collapses on thin token evidence', () => {
    const lines = [
      '[2026-01-02] alex: done',
      '[2026-01-03] alex: done again today',
    ];
    expect(dedupeMentionLines(lines)).toEqual(lines);
  });

  it('empty input passes through', () => {
    expect(dedupeMentionLines([])).toEqual([]);
  });
});

describe('extractOrderingTopic strips the exact-N ask scaffold (R1)', () => {
  it('the BEAM exact-N constraint never reaches the topic', () => {
    const topic = extractOrderingTopic(
      'Can you list the order in which I brought up different aspects of ' +
        'developing my personal budget tracker throughout our ' +
        'conversations? Mention ONLY and ONLY three items in your answer.',
    );
    expect(topic.toLowerCase()).not.toContain('mention');
    expect(topic.toLowerCase()).not.toContain('items');
    expect(topic.toLowerCase()).not.toContain('answer');
    expect(topic.toLowerCase()).toContain('budget tracker');
  });

  it('ask-scaffold words never count as topic terms', () => {
    for (const w of ['mention', 'only', 'items', 'order', 'answer']) {
      expect(topicTerms(`${w} budget tracker`)).not.toContain(w);
    }
  });
});

describe('segment-level mention record under dedupeAspects (R1)', () => {
  function makeService(segments: Array<Record<string, unknown>>) {
    const surreal = {
      withCompany: async (
        _c: string,
        fn: (db: unknown) => Promise<unknown>,
      ) => {
        let call = 0;
        return fn({
          query: async () => {
            call += 1;
            // dense leg first, then bm25 — return everything lexical so
            // every segment counts as a mention.
            return [call === 1 ? [] : segments];
          },
        });
      },
    } as unknown as SurrealService;
    const embedder = {
      embed: async () => [0.1, 0.2],
    } as unknown as EmbedderService;
    return new MentionScanService(surreal, embedder);
  }

  // One long session (same hour) raising two DISTINCT aspects across
  // two segments — the V9 per-session collapse kept only one of them.
  const segments = [
    {
      id: 'episode_segment:s1',
      text: '[2024-03-15] user: added a debounce delay to cut API calls',
      occurredAt: '2024-03-15T10:00:00Z',
      score: 2,
    },
    {
      id: 'episode_segment:s2',
      text: '[2024-03-15] user: worried rapid input bypasses the debounce entirely',
      occurredAt: '2024-03-15T10:20:00Z',
      score: 2,
    },
  ];

  it('keeps within-session aspect sequence when dedupeAspects is on', async () => {
    const lines = await makeService(segments).mentionLines({
      companyId: 'c1',
      query: 'In what order did I bring up the debounce aspects?',
      callerScopes: [],
      dedupeAspects: true,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('added a debounce delay');
    expect(lines[1]).toContain('rapid input bypasses');
  });

  it('default (off) keeps the V9 one-line-per-session record', async () => {
    const lines = await makeService(segments).mentionLines({
      companyId: 'c1',
      query: 'In what order did I bring up the debounce aspects?',
      callerScopes: [],
    });
    expect(lines).toHaveLength(1);
  });
});

describe('ordering frame in the generator prompt', () => {
  const base = {
    query: 'In what order did I bring up the migration aspects?',
    factLines: ['[knowledge_fact:f1] Alex — work: migrated the database'],
    transcriptLines: ['[2026-01-02] alex: first the schema, then the data'],
    timelineEvidence: true,
    answerLang: null,
    lane: 'enumeration' as const,
  };

  it('replaces the enumeration frame when orderingFrame is set', () => {
    const msg = buildGeneratorUserMessage({ ...base, orderingFrame: true });
    expect(msg).toContain(ORDERING_LANE_INSTRUCTION);
    expect(msg).not.toContain(ENUMERATION_LANE_INSTRUCTION);
    // The mention-record header still frames the transcript section.
    expect(msg).toContain('MENTION RECORD');
  });

  it('off — byte-identical to the pre-V10 enumeration prompt', () => {
    const off = buildGeneratorUserMessage(base);
    const legacy = buildGeneratorUserMessage({ ...base });
    expect(off).toBe(legacy);
    expect(off).toContain(ENUMERATION_LANE_INSTRUCTION);
    expect(off).not.toContain(ORDERING_LANE_INSTRUCTION);
  });

  it('applies even without a routed lane (temporal precedence case)', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      lane: null,
      orderingFrame: true,
    });
    expect(msg).toContain(ORDERING_LANE_INSTRUCTION);
  });
});

describe('RETRIEVAL_ORDERING_FRAME profile point', () => {
  it('defaults off; env enables; overlays per tenant', () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).orderingFrame).toBe(
      false,
    );
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ORDERING_FRAME: '1',
      } as NodeJS.ProcessEnv).orderingFrame,
    ).toBe(true);
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { orderingFrame: true },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).orderingFrame).toBe(true);
    expect(resolveRetrievalProfileFor('other', env).orderingFrame).toBe(false);
  });
});
