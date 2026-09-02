/**
 * Unit sanity for the memory-fitness scorers (test/eval/memory-fitness/
 * scorers.ts) — the mechanical judges of the harness. Pure fixtures, no
 * HTTP: if these are wrong, every scorecard is wrong, so they get their
 * own spec even though the harness itself never runs in CI.
 */
import {
  checkEvolution,
  classifyConflictAnswer,
  containsAnyOf,
  dateVariants,
  findForbidden,
  isAbstention,
  matchesDate,
  missingKeyPhrases,
  walkProvenance,
} from './eval/memory-fitness/scorers';

describe('memory-fitness scorers', () => {
  describe('containsAnyOf / findForbidden', () => {
    it('matches case-insensitively', () => {
      expect(containsAnyOf('We moved to NATS JetStream.', ['jetstream'])).toBe(true);
      expect(containsAnyOf('We moved to NATS JetStream.', ['Redis'])).toBe(false);
    });

    it('names the first forbidden needle present', () => {
      expect(findForbidden('The queue is Redis Streams.', ['Redis'])).toBe('Redis');
      expect(findForbidden('The queue is NATS.', ['Redis'])).toBeNull();
    });
  });

  describe('date matcher', () => {
    it('builds the accepted phrasings of an ISO date', () => {
      expect(dateVariants('2026-03-18')).toEqual([
        '2026-03-18',
        '2026/03/18',
        'March 18',
        '18 March',
        'Mar 18',
        '18 Mar',
      ]);
    });

    it('accepts common phrasings, including ordinal suffixes via substring', () => {
      expect(matchesDate('We decided on 2026-03-18.', '2026-03-18')).toBe(true);
      expect(matchesDate('Decided on March 18th, 2026.', '2026-03-18')).toBe(true);
      expect(matchesDate('It happened on 18 March.', '2026-03-18')).toBe(true);
      expect(matchesDate('Launch slipped to May 6.', '2026-05-06')).toBe(true);
    });

    it('rejects other dates', () => {
      expect(matchesDate('We decided on 2026-04-15.', '2026-03-18')).toBe(false);
      expect(matchesDate('No date here at all.', '2026-03-18')).toBe(false);
    });

    it('throws on a non yyyy-mm-dd expectation', () => {
      expect(() => dateVariants('March 18')).toThrow(/yyyy-mm-dd/);
    });
  });

  describe('abstention detector', () => {
    it('treats null / empty answers as abstention', () => {
      expect(isAbstention(null)).toBe(true);
      expect(isAbstention(undefined)).toBe(true);
      expect(isAbstention('   ')).toBe(true);
    });

    it('recognizes decline phrasings including the guardrail sentinel', () => {
      expect(isAbstention("I don't have grounded evidence for that.")).toBe(true);
      expect(isAbstention('There is no record of an on-call lead.')).toBe(true);
      expect(isAbstention('I cannot determine the SLA from memory.')).toBe(true);
    });

    it('recognizes an abstain reason on a null-ish serving', () => {
      expect(isAbstention('some text', 'no_facts')).toBe(true);
    });

    it('does not flag a substantive answer', () => {
      expect(isAbstention('The service listens on port 8443.')).toBe(false);
    });
  });

  describe('provenance walker', () => {
    const prov = {
      factId: 'knowledge_fact:abc',
      episodes: [
        { episodeId: 'memory_episode:e1', text: 'Kickoff log, 2026-03-02. Starting ledger-sync.' },
        {
          episodeId: 'memory_episode:e2',
          text: 'every enqueue now carries idempotencyKey = sha256(payoutId + attemptDate)',
        },
      ],
    };

    it('finds the episode quoting a seeded fragment', () => {
      expect(walkProvenance(prov, ['idempotency'])).toEqual({
        episodeId: 'memory_episode:e2',
        fragment: 'idempotency',
      });
    });

    it('returns null when no episode quotes a fragment', () => {
      expect(walkProvenance(prov, ['outbox'])).toBeNull();
    });

    it('handles empty / malformed provenance without throwing', () => {
      expect(walkProvenance({}, ['idempotency'])).toBeNull();
      expect(walkProvenance({ episodes: [{ episodeId: 'e3' }] }, ['idempotency'])).toBeNull();
    });
  });

  describe('evolution checker', () => {
    const events = [
      { predicate: 'queue_backend', object: 'Redis Streams', at: '2026-03-02T09:20:00Z' },
      { predicate: 'service_port', object: '8443', at: '2026-03-02T09:15:00Z' },
      { predicate: 'queue_backend', object: 'NATS JetStream', at: '2026-03-18T09:35:00Z' },
    ];

    it('passes when both values are retained in order', () => {
      const v = checkEvolution(events, 'queue_backend', ['Redis Streams'], ['JetStream']);
      expect(v.pass).toBe(true);
    });

    it('fails when the old value was garbage-collected', () => {
      const onlyNew = events.filter((e) => e.object !== 'Redis Streams');
      const v = checkEvolution(onlyNew, 'queue_backend', ['Redis Streams'], ['JetStream']);
      expect(v.pass).toBe(false);
      expect(v.detail).toMatch(/old value missing/);
    });

    it('fails when history orders new before old', () => {
      const flipped = [
        { predicate: 'queue_backend', object: 'NATS JetStream', at: '2026-03-01T00:00:00Z' },
        { predicate: 'queue_backend', object: 'Redis Streams', at: '2026-03-18T00:00:00Z' },
      ];
      const v = checkEvolution(flipped, 'queue_backend', ['Redis Streams'], ['JetStream']);
      expect(v.pass).toBe(false);
      expect(v.detail).toMatch(/orders/);
    });

    it('fails distinctly when the predicate has no matching events', () => {
      const v = checkEvolution(events, 'retry_policy', ['fixed'], ['exponential']);
      expect(v.pass).toBe(false);
      expect(v.detail).toMatch(/no retry_policy events/);
    });
  });

  describe('key-phrase scorer', () => {
    it('satisfies plain strings and any-of groups', () => {
      const text = 'Ports 8443 and 9464 are taken; use the idempotency key idiom.';
      expect(missingKeyPhrases(text, ['8443', ['idempotencyKey', 'idempotency key']])).toEqual([]);
    });

    it('reports each unsatisfied group', () => {
      expect(missingKeyPhrases('Nothing useful.', ['8443', ['a', 'b']])).toEqual(['8443', 'a | b']);
    });
  });

  describe('conflict-answer classifier', () => {
    it('classifies all four behaviours', () => {
      expect(
        classifyConflictAnswer('Sources disagree: 17:00 UTC vs 16:30 UTC.', ['17:00'], ['16:30']),
      ).toBe('both-sides');
      expect(classifyConflictAnswer('The cutoff is 17:00 UTC.', ['17:00'], ['16:30'])).toBe(
        'one-sided',
      );
      expect(classifyConflictAnswer(null, ['17:00'], ['16:30'])).toBe('abstained');
      expect(classifyConflictAnswer('The cutoff is noon.', ['17:00'], ['16:30'])).toBe('neither');
    });
  });
});
