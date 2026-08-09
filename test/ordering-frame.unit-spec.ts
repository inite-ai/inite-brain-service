import { dedupeMentionLines } from '../src/synthesize/mention-scan';
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
