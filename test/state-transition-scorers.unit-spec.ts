/**
 * Unit sanity for the state-transition scorers (test/eval/
 * state-transitions/scorers.ts) — the mechanical judges of the battery.
 * Pure fixtures, no HTTP: if these are wrong, every scorecard is wrong,
 * so they get their own spec even though the battery itself never runs
 * in CI. The generic primitives the battery reuses (containsAnyOf,
 * isAbstention, walkProvenance, …) are covered by the sibling's
 * test/memory-fitness-scorers.unit-spec.ts.
 */
import {
  checkBelief,
  checkHistorySequence,
  scoreServe,
  type BeliefLike,
  type HistoryEvent,
} from './eval/state-transitions/scorers';

describe('state-transition scorers', () => {
  describe('belief matcher', () => {
    const beliefs: BeliefLike[] = [
      {
        subject: 'Sasha',
        field: 'work laptop',
        value: 'MacBook Pro',
        priorValue: 'ThinkPad X1 Carbon',
        revision: 2,
      },
      { subject: 'Sasha', field: 'home city', value: 'Lisbon', revision: 1 },
      { subject: 'Boris', field: 'company car', value: 'returned', revision: 2 },
    ];

    it('passes on value + prior + revision for the matching (subject, field) key', () => {
      const v = checkBelief(beliefs, {
        subjectTokens: ['Sasha', 'user'],
        fieldTokens: ['laptop'],
        valueMarkers: ['MacBook'],
        priorMarkers: ['ThinkPad'],
        minRevision: 2,
      });
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('work laptop');
    });

    it('fails when no belief matches the (subject, field) token filters', () => {
      const v = checkBelief(beliefs, {
        subjectTokens: ['Sasha'],
        fieldTokens: ['motorcycle', 'bike'],
        valueMarkers: ['none'],
      });
      expect(v.pass).toBe(false);
      expect(v.detail).toMatch(/no belief matches/);
    });

    it('fails naming the closest candidate when constraints miss', () => {
      // The field-drift baseline: the belief exists but never revised,
      // so priorValue is absent and revision is stuck at 1.
      const v = checkBelief(beliefs, {
        subjectTokens: ['Sasha'],
        fieldTokens: ['city', 'residence'],
        valueMarkers: ['Porto'],
        priorMarkers: ['Lisbon'],
        minRevision: 2,
      });
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('value="Lisbon"');
      expect(v.detail).toContain('prior=absent');
    });

    it('requires priorValue to EXIST when priorMarkers are declared', () => {
      const v = checkBelief(beliefs, {
        subjectTokens: ['Sasha'],
        fieldTokens: ['city'],
        valueMarkers: ['Lisbon'],
        priorMarkers: ['Porto'],
      });
      expect(v.pass).toBe(false);
    });

    it('supports priorAbsent for first-revision beliefs', () => {
      const ok = checkBelief(beliefs, {
        subjectTokens: ['Sasha'],
        fieldTokens: ['city'],
        valueMarkers: ['Lisbon'],
        priorAbsent: true,
      });
      expect(ok.pass).toBe(true);
      const notAbsent = checkBelief(beliefs, {
        subjectTokens: ['Sasha'],
        fieldTokens: ['laptop'],
        priorAbsent: true,
      });
      expect(notAbsent.pass).toBe(false);
    });

    it('enforces minRevision', () => {
      const v = checkBelief(beliefs, {
        subjectTokens: ['Boris'],
        fieldTokens: ['car'],
        minRevision: 3,
      });
      expect(v.pass).toBe(false);
      expect(v.detail).toMatch(/none the constraints/);
    });

    it('pins third-party subjects — a speaker-attributed belief does not count', () => {
      const misattributed: BeliefLike[] = [
        { subject: 'Sasha', field: 'company car', value: 'returned', revision: 2 },
      ];
      const v = checkBelief(misattributed, {
        subjectTokens: ['Boris'],
        fieldTokens: ['car'],
      });
      expect(v.pass).toBe(false);
    });
  });

  describe('history subsequence', () => {
    const events: HistoryEvent[] = [
      { predicate: 'joined', object: 'chess club', at: '2026-08-02T18:05:00Z' },
      { predicate: 'quit', object: 'chess club', at: '2026-08-09T18:05:00Z' },
      { predicate: 'rejoined', object: 'chess club', at: '2026-08-20T18:05:00Z' },
    ];

    it('passes when every stage is retained in order', () => {
      const v = checkHistorySequence(events, [['join'], ['quit', 'left'], ['rejoin', 'again']]);
      expect(v.pass).toBe(true);
      expect(v.matchedStages).toBe(3);
    });

    it('greedy matching survives marker overlap (join ⊂ rejoined)', () => {
      // Stage 1 consumes the FIRST 'join' match (the 2026-08-02 event),
      // leaving the rejoin event for stage 3 — first-match-per-stage
      // scoring would break on exactly this fixture.
      const v = checkHistorySequence(events, [['join'], ['quit'], ['join']]);
      expect(v.pass).toBe(true);
    });

    it('fails when a stage was garbage-collected', () => {
      const noQuit = events.filter((e) => e.predicate !== 'quit');
      const v = checkHistorySequence(noQuit, [['join'], ['quit'], ['rejoin']]);
      expect(v.pass).toBe(false);
      expect(v.matchedStages).toBe(1);
      expect(v.detail).toMatch(/stage 2\/3/);
    });

    it('fails when history orders stages backwards', () => {
      const flipped: HistoryEvent[] = [
        { predicate: 'owns', object: 'MacBook Pro', at: '2026-08-04T09:00:00Z' },
        { predicate: 'owns', object: 'ThinkPad X1', at: '2026-08-12T09:00:00Z' },
      ];
      const v = checkHistorySequence(flipped, [['ThinkPad'], ['MacBook']]);
      expect(v.pass).toBe(false);
    });

    it('orders same-day events by time of day', () => {
      const sameDay: HistoryEvent[] = [
        { predicate: 'returned', object: 'standing desk', at: '2026-08-11T18:05:00Z' },
        { predicate: 'signed_up', object: 'standing desk trial', at: '2026-08-11T10:05:00Z' },
      ];
      const v = checkHistorySequence(sameDay, [['signed', 'trial'], ['returned']]);
      expect(v.pass).toBe(true);
    });

    it('matches markers against predicate and object combined', () => {
      const v = checkHistorySequence(
        [{ predicate: 'membership_status', object: 'chess club', at: '2026-08-02T18:05:00Z' }],
        [['member']],
      );
      expect(v.pass).toBe(true);
    });
  });

  describe('serve verdict', () => {
    it('passes an honest negative answer that trips the decline regex', () => {
      // "don't have" matches the shared ABSTAIN_RE — marker-first
      // scoring must still pass it, because the expected truth IS a
      // negation (the dispose scenario).
      const v = scoreServe("You don't have a bike anymore — you sold the Kawasaki.", undefined, {
        expectAnyOf: ['sold', 'no longer', 'not own'],
      });
      expect(v.status).toBe('pass');
    });

    it('fails a pure abstention on a known state', () => {
      const v = scoreServe("I don't have grounded evidence for that.", undefined, {
        expectAnyOf: ['sold', 'no longer', 'not own'],
      });
      expect(v.status).toBe('fail');
      expect(v.detail).toMatch(/abstained/);
    });

    it('forbidden marker wins even when an expect marker is present', () => {
      const v = scoreServe('Your laptop is a MacBook Pro, formerly a ThinkPad.', undefined, {
        expectAnyOf: ['MacBook'],
        forbidAnyOf: ['ThinkPad'],
      });
      expect(v.status).toBe('fail');
      expect(v.detail).toMatch(/forbidden marker/);
    });

    it('fails a substantive answer that misses every expect marker', () => {
      const v = scoreServe('You quit the chess club on August 9th.', undefined, {
        expectAnyOf: ['member', 'rejoined'],
      });
      expect(v.status).toBe('fail');
      expect(v.detail).toMatch(/expected one of/);
    });

    it('conflict mode passes both-sides and abstention, fails one-sided', () => {
      const sides = { conflictSides: { sideA: ['December'], sideB: ['September'] } };
      expect(
        scoreServe('Sources disagree: December 2026 vs September 2026.', undefined, sides).status,
      ).toBe('pass');
      expect(scoreServe(null, undefined, sides).status).toBe('pass');
      expect(scoreServe('The lease ends in December 2026.', undefined, sides).status).toBe('fail');
      expect(scoreServe('The lease ends next year.', undefined, sides).status).toBe('fail');
    });

    it('expectAbstain passes only on abstention', () => {
      expect(scoreServe(null, 'no_facts', { expectAbstain: true }).status).toBe('pass');
      expect(scoreServe('The answer is 42.', undefined, { expectAbstain: true }).status).toBe(
        'fail',
      );
    });
  });
});
