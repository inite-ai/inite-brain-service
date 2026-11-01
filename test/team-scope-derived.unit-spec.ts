import { teamTagsOf, withSourceScope, scopeForUser } from '../src/auth/scope-tags';
import { runWithWriteScope } from '../src/auth/write-scope';

describe('team scope on what is read from a team-scoped source', () => {
  const eng = 'team:gl1:eng';

  it('a derived row gains the team tags of its sources, beside circles; it only narrows', () => {
    expect(
      withSourceScope([], [{ scope: [eng] }, { scope: ['circle:c1'] }, { scope: null }, {}]),
    ).toEqual(['circle:c1', eng]);
    expect(withSourceScope(['user:u1'], [{ scope: [eng] }, { scope: [eng] }])).toEqual([
      'user:u1',
      eng,
    ]);
    expect(withSourceScope([], [{ scope: ['user:u2'] }])).toEqual([]);
  });

  it('teamTagsOf keeps only team tags', () => {
    expect(teamTagsOf(['user:u1', eng, 'circle:c1'])).toEqual([eng]);
    expect(teamTagsOf(undefined)).toEqual([]);
  });

  it('a write with no user under a team scope is scoped to it; a personal write is not widened', () => {
    runWithWriteScope([eng], () => {
      expect(scopeForUser(undefined)).toEqual([eng]);
      expect(scopeForUser('u1')).toEqual(['user:u1']);
    });
    expect(scopeForUser(undefined)).toEqual([]);
  });
});
