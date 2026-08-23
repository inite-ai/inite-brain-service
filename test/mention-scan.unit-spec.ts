import {
  bestMentionPerSession,
  extractOrderingTopic,
  filterMentions,
  pickMentionLine,
  topicTerms,
  type ScanRow,
} from '../src/synthesize/mention-scan';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

/**
 * V9 §2 — mention-scan lane for ordering questions. The V8 top-K
 * appendix measured null on event_ordering (0→2.5): coverage, not
 * order, is the bottleneck — golds enumerate a topic across ALL
 * sessions and top-K similarity windows cannot. The scan extracts the
 * TOPIC, tests every session for a mention, and emits one dated line
 * per session-mention in occurredAt order.
 */

describe('extractOrderingTopic', () => {
  const cases: Array<[string, string[]]> = [
    [
      'Can you list the order in which I brought up different aspects of the autocomplete feature?',
      ['autocomplete feature'],
    ],
    ['In what order did I mention the triangle concepts?', ['triangle concepts']],
    [
      'Can you walk me through the order in which I raised deployment topics?',
      ['deployment topics'],
    ],
    [
      'Did I visit Lisbon before or after starting the new job?',
      ['visit lisbon', 'starting the new job'],
    ],
    ['What was the order of my research projects across the sessions?', ['research projects']],
  ];
  it.each(cases)('%s', (query, mustContain) => {
    const topic = extractOrderingTopic(query).toLowerCase();
    for (const frag of mustContain) expect(topic).toContain(frag);
    // The scaffold itself must not survive into the search phrase.
    expect(topic).not.toMatch(/\border in which\b/);
    expect(topic).not.toMatch(/\bcan you\b/);
  });

  it('falls back to the raw query when stripping leaves nothing', () => {
    expect(extractOrderingTopic('In what order?')).toBe('In what order?');
  });
});

describe('topicTerms', () => {
  it('keeps content words, drops glue and short tokens', () => {
    expect(topicTerms('the autocomplete feature of my app')).toEqual(
      expect.arrayContaining(['autocomplete', 'feature', 'app']),
    );
    expect(topicTerms('the of and')).toEqual([]);
  });
});

const row = (o: Partial<ScanRow> & { id: string }): ScanRow => ({
  text: `[2024-01-01] user: about ${o.id}`,
  occurredAt: 0,
  ...o,
});

describe('filterMentions', () => {
  it('lexical hits always count', () => {
    const rows = [row({ id: 'a', lex: 2.1 }), row({ id: 'b', sim: 0.1 })];
    expect(filterMentions(rows).map((r) => r.id)).toEqual(['a']);
  });

  it('dense-only rows need the relative + absolute floors', () => {
    const rows = [
      row({ id: 'top', sim: 0.6 }),
      row({ id: 'near', sim: 0.57 }), // ≥ 0.9×0.6 and ≥ abs floor
      row({ id: 'far', sim: 0.4 }), // < 0.9×0.6
    ];
    expect(filterMentions(rows).map((r) => r.id)).toEqual(['top', 'near']);
  });

  it('absolute floor holds even when everything is weak', () => {
    const rows = [row({ id: 'weak', sim: 0.2 })];
    expect(filterMentions(rows)).toEqual([]);
  });
});

describe('bestMentionPerSession', () => {
  const H = 3600_000;
  it('one line per inactivity-gap session, chronological', () => {
    const rows = [
      row({ id: 's1a', occurredAt: 0, lex: 1 }),
      row({ id: 's1b', occurredAt: 10 * 60_000, lex: 3 }), // same session, stronger
      row({ id: 's2', occurredAt: 5 * H, sim: 0.5 }),
      row({ id: 's3', occurredAt: 10 * H, lex: 2 }),
    ];
    expect(bestMentionPerSession(rows).map((r) => r.id)).toEqual(['s1b', 's2', 's3']);
  });

  it('lexical strength beats similarity inside a session', () => {
    const rows = [
      row({ id: 'simmy', occurredAt: 0, sim: 0.99 }),
      row({ id: 'lexy', occurredAt: 60_000, lex: 0.5 }),
    ];
    expect(bestMentionPerSession(rows).map((r) => r.id)).toEqual(['lexy']);
  });
});

describe('pickMentionLine', () => {
  const seg = [
    '[2024-03-01] user: hello there',
    '[2024-03-01] user: I started sketching the autocomplete feature today',
    '[2024-03-01] assistant: sounds good',
  ].join('\n');

  it('picks the line with the most topic-term overlap', () => {
    expect(pickMentionLine(seg, ['autocomplete', 'feature'])).toContain(
      'sketching the autocomplete feature',
    );
  });

  it('falls back to the first line when nothing overlaps', () => {
    expect(pickMentionLine(seg, ['zeppelin'])).toBe('[2024-03-01] user: hello there');
  });

  it('caps line length at 240 chars', () => {
    const long = `[2024-03-01] user: ${'x'.repeat(500)} autocomplete`;
    const picked = pickMentionLine(long, ['autocomplete']);
    expect(picked.length).toBeLessThanOrEqual(240);
    expect(picked.endsWith('…')).toBe(true);
  });
});

describe("timelineEvidence='scan' profile point", () => {
  it('scan round-trips through the profile resolver', () => {
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_TIMELINE_EVIDENCE: 'scan',
      } as NodeJS.ProcessEnv).timelineEvidence,
    ).toBe('scan');
  });
});
