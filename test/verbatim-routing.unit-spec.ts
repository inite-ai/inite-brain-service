import { resolveVerbatimMode } from '../src/search/verbatim-routing';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

/**
 * V7: verbatimEvidence='routed' — per-query dispatch between the two
 * V6-measured regimes. Timeline-shaped → shape_conditioned (fused lost
 * −7.1pp at 2.7× tokens on TR); session-shaped → fused (+7.1pp on SSA).
 */
describe('verbatim routing (routed mode)', () => {
  describe('timeline dispatch lexicon (via resolveVerbatimMode)', () => {
    const timeline = [
      'When did I first mention the marathon?',
      'How long ago did we discuss the lease?',
      'What date did I sign up for the pottery class?',
      'On what day did the delivery arrive?',
      'Was the interview before or after the conference?',
      'How many months have passed since my dentist appointment?',
      'When was the last time I asked about GPU pricing?',
    ];
    const session = [
      'What did you suggest for my resume summary?',
      'Can you recommend a follow-up book to the one we discussed?',
      'What was your advice about negotiating salary?',
      'Summarize how my job search has progressed.',
      'Which laptops did we compare?',
    ];
    it.each(timeline)('timeline → shape_conditioned: %s', (q) => {
      expect(resolveVerbatimMode('routed', q)).toBe('shape_conditioned');
    });
    it.each(session)('session → fused: %s', (q) => {
      expect(resolveVerbatimMode('routed', q)).toBe('fused');
    });
  });

  describe('resolveVerbatimMode', () => {
    it('routed dispatches by shape', () => {
      expect(resolveVerbatimMode('routed', 'When did I buy the couch?')).toBe(
        'shape_conditioned',
      );
      expect(
        resolveVerbatimMode('routed', 'What did you suggest for dinner?'),
      ).toBe('fused');
    });
    it('non-routed modes resolve to themselves', () => {
      for (const m of ['off', 'shape_conditioned', 'always', 'fused'] as const) {
        expect(resolveVerbatimMode(m, 'When did I buy the couch?')).toBe(m);
        expect(resolveVerbatimMode(m, 'What did you suggest?')).toBe(m);
      }
    });
  });

  it('RETRIEVAL_VERBATIM_EVIDENCE=routed round-trips through the profile', () => {
    const p = resolveRetrievalProfile({
      RETRIEVAL_VERBATIM_EVIDENCE: 'routed',
    } as NodeJS.ProcessEnv);
    expect(p.verbatimEvidence).toBe('routed');
  });
});
