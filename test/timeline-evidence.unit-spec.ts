import { detectOrderingShape, detectLane } from '../src/synthesize/answer-router';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';

/**
 * V8 §2 — timeline evidence for mention-order questions. The measured
 * BEAM event_ordering failure (2.5-5%): questions route to the
 * enumeration lane and the generator enumerates chronologically, but
 * event-time extraction collapses a session's mentions onto one
 * validFrom date, so mention ORDER is unrecoverable from facts. Under
 * timelineEvidence='routed', ordering-shaped questions also get the
 * chronological segment appendix — the occurredAt-ordered mention
 * record — with a mention-record section header.
 */
describe('detectOrderingShape (the order-lexicon)', () => {
  const ordering = [
    // The dominant BEAM event_ordering phrasing (40/40 on the live row).
    'Can you list the order in which I brought up different aspects of the autocomplete feature?',
    'Can you walk me through the order in which I raised deployment topics?',
    'Can you list in order how I brought up my research projects?',
    'In what order did I mention the triangle concepts?',
    'Did I visit Lisbon before or after starting the new job?',
    'Which came first, the marathon or the wedding?',
  ];
  const notOrdering = [
    'How many model kits have I bought?',
    'List all the restaurants I mentioned.',
    'What did you suggest for my resume?',
    'How long ago did we discuss the lease?',
    'Summarize how my job search has progressed.',
  ];
  it.each(ordering)('ordering: %s', (q) => {
    expect(detectOrderingShape(q)).toBe(true);
  });
  it.each(notOrdering)('not ordering: %s', (q) => {
    expect(detectOrderingShape(q)).toBe(false);
  });

  it('ordering shapes still route to the enumeration lane', () => {
    expect(detectLane('Can you list the order in which I brought up X?')).toBe('enumeration');
    expect(detectLane('Which came first, the marathon or the wedding?')).toBe('enumeration');
  });
});

describe('RETRIEVAL_TIMELINE_EVIDENCE profile point', () => {
  it('defaults off; routed round-trips; garbage rejects to off', () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).timelineEvidence).toBe('off');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_TIMELINE_EVIDENCE: 'routed',
      } as NodeJS.ProcessEnv).timelineEvidence,
    ).toBe('routed');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_TIMELINE_EVIDENCE: 'always',
      } as NodeJS.ProcessEnv).timelineEvidence,
    ).toBe('off');
  });

  it('overlays per tenant via RETRIEVAL_PROFILE_OVERRIDES', () => {
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { timelineEvidence: 'routed' },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).timelineEvidence).toBe('routed');
    expect(resolveRetrievalProfileFor('other', env).timelineEvidence).toBe('off');
  });
});

describe('mention-record section header', () => {
  const base = {
    query: 'In what order did I mention things?',
    factLines: ['- fact one'],
    transcriptLines: ['[2024-03-01] user: first topic'],
    answerLang: null,
  };

  it('default header without the timeline flag (no drift)', () => {
    const msg = buildGeneratorUserMessage({ ...base });
    expect(msg).toContain('use them to answer, but cite factIds only');
    expect(msg).not.toContain('MENTION RECORD');
  });

  it('timelineEvidence flags the excerpts as the mention record', () => {
    const msg = buildGeneratorUserMessage({ ...base, timelineEvidence: true });
    expect(msg).toContain('MENTION RECORD');
    expect(msg).toContain('preferring it over fact date stamps');
  });
});
