import { resolveVerbatimMode } from '../src/search/verbatim-routing';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

/**
 * V7: verbatimEvidence='routed' — per-query dispatch between the two
 * V6-measured regimes. The three-block evidence (n=239 pooled): fused
 * vs shape_conditioned is SSA +7.1pp / SSU −10.0pp / TR −8.3pp — the
 * ONLY winning class is verbatim-shaped (assistant-content) asks, so
 * those route to fused and everything else stays shape_conditioned.
 */
describe('verbatim routing (routed mode)', () => {
  describe('dispatch (via resolveVerbatimMode)', () => {
    const verbatimShaped = [
      'What did you suggest for my resume summary?',
      'What was your advice about negotiating salary?',
      'What were the steps you walked me through for the visa?',
      'Quote what you said about the deposit.',
      'What did the assistant recommend for the rash?',
    ];
    const everythingElse = [
      // timeline-shaped (TR class, fused −8.3pp)
      'When did I first mention the marathon?',
      'How long ago did we discuss the lease?',
      'What date did I sign up for the pottery class?',
      // user-fact questions (SSU class, fused −10.0pp)
      'What kind of dog do I have?',
      'Which laptops did we compare?',
      'Where does my sister live?',
      // generic session asks
      'Summarize how my job search has progressed.',
      'Can you recommend a follow-up book to the one we discussed?',
    ];
    it.each(verbatimShaped)('verbatim-shaped → fused: %s', (q) => {
      expect(resolveVerbatimMode('routed', q)).toBe('fused');
    });
    it.each(everythingElse)('otherwise → shape_conditioned: %s', (q) => {
      expect(resolveVerbatimMode('routed', q)).toBe('shape_conditioned');
    });
  });

  it('non-routed modes resolve to themselves', () => {
    for (const m of ['off', 'shape_conditioned', 'always', 'fused'] as const) {
      expect(resolveVerbatimMode(m, 'When did I buy the couch?')).toBe(m);
      expect(resolveVerbatimMode(m, 'What did you suggest?')).toBe(m);
    }
  });

  it('RETRIEVAL_VERBATIM_EVIDENCE=routed round-trips through the profile', () => {
    const p = resolveRetrievalProfile({
      RETRIEVAL_VERBATIM_EVIDENCE: 'routed',
    } as NodeJS.ProcessEnv);
    expect(p.verbatimEvidence).toBe('routed');
  });
});
