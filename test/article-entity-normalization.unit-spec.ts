import { articleNameVariants } from '../src/ingest/entity-upsert.service';

// ── INGEST_ARTICLE_NORMALIZATION (state-transitions s07 entity-split
// class): "the office lease" and "office lease" are ONE referent. The
// pure variant expansion is the whole decision surface — the service
// merely runs an IN-lookup over it with a unique-match fence — so the
// expansion is what gets pinned here.
describe('articleNameVariants', () => {
  it('expands an articled name to its stripped form plus the other articles', () => {
    expect(articleNameVariants('the office lease')).toEqual([
      'office lease',
      'a office lease',
      'an office lease',
    ]);
  });

  it('expands a bare name to all three articled forms', () => {
    expect(articleNameVariants('office lease')).toEqual([
      'the office lease',
      'a office lease',
      'an office lease',
    ]);
  });

  it('never emits the input itself (the exact match already ran)', () => {
    for (const name of ['the office lease', 'office lease', 'a drone', 'an apartment']) {
      expect(articleNameVariants(name)).not.toContain(name);
    }
  });

  it('strips only LEADING articles — inner articles are part of the name', () => {
    expect(articleNameVariants('state of the art rig')).toEqual([
      'the state of the art rig',
      'a state of the art rig',
      'an state of the art rig',
    ]);
  });

  it('requires whitespace after the article — "theater" is not "the ater"', () => {
    expect(articleNameVariants('theater')).toEqual(['the theater', 'a theater', 'an theater']);
  });

  it('round-trips: variants of the articled and bare forms intersect on the shared referent', () => {
    const ofArticled = articleNameVariants('the office lease');
    const ofBare = articleNameVariants('office lease');
    // The bare form is a variant of the articled one, and vice versa —
    // whichever arrives second finds whichever landed first.
    expect(ofArticled).toContain('office lease');
    expect(ofBare).toContain('the office lease');
  });
});
