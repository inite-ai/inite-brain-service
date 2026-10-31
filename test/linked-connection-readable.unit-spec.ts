import { connectionReadable } from '../src/source-plane/source-linked.service';
import { teamTag } from '../src/auth/scope-tags';

describe('linked lane: which connections an asker may question', () => {
  const team = { scope: [teamTag('source_connection:gl', 'eng')] };

  it('a tenant-wide connection answers everyone', () => {
    expect(connectionReadable({ scope: [] }, undefined)).toBe(true);
    expect(connectionReadable({}, 'u1')).toBe(true);
  });

  it('a personal connection answers its user only, never a caller who names no one', () => {
    expect(connectionReadable({ userId: 'u1' }, 'u1')).toBe(true);
    expect(connectionReadable({ userId: 'u1' }, 'u2')).toBe(false);
    expect(connectionReadable({ userId: 'u1' }, undefined)).toBe(false);
  });

  it('a team connection answers a principal holding its tag; tenant-wide authority passes', () => {
    expect(connectionReadable(team, 'u1')).toBe(false);
    expect(connectionReadable(team, undefined)).toBe(true);
  });
});
