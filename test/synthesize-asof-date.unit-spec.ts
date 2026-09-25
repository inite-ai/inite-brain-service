/**
 * An asOf question is asked AT its date: the generator is told that date
 * whatever the genre's default anchoring. Measured on production: "на
 * какой модели работал движок 22 сентября?" was answered with the model
 * it switched to on the 24th.
 */
import { resolveLaneDateContext } from '../src/synthesize/synthesize.helpers';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

describe('asOf questions are answered for their date', () => {
  const profile = { ...resolveRetrievalProfile({}), dateAnchoring: 'none' as const };

  it('the generator is given the asOf date even under dateAnchoring=none', () => {
    expect(resolveLaneDateContext(profile, null, '2026-09-22T12:00:00Z')).toBe('2026-09-22');
    expect(resolveLaneDateContext(profile, null, undefined)).toBeUndefined();
  });
});
