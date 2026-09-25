/**
 * Relatives named by role are the speaker's own (src/ingest/relative-role.ts):
 * which mentions count, how the role is canonicalized across surfaces and
 * languages, and that nothing is scoped without a user.
 */
import { relativeHint, relativeRoleOf } from '../src/ingest/relative-role';

describe('relativeRoleOf', () => {
  it.each([
    ['Father', 'father'],
    ['my dad', 'father'],
    ['Mom', 'mother'],
    ['Both parents', 'parents'],
    ['our kids', 'children'],
    ['older brother', 'older brother'],
    ['my little sister', 'younger sister'],
    ['мама', 'mother'],
    ['моя младшая сестра', 'younger sister'],
    ['minha mãe', 'mother'],
    ['Mutter', 'mother'],
  ])('%s → %s', (name, role) => {
    expect(relativeRoleOf(name)).toBe(role);
  });

  it.each([
    'Maria',
    'Partner', // a business role in a work tenant
    'best friend',
    "Rui's mother", // someone else's relative
    'his father',
    'new CTO',
    'Father Brown Bakery',
  ])('%s is not the speaker’s relative', (name) => {
    expect(relativeRoleOf(name)).toBeUndefined();
  });
});

describe('relativeHint', () => {
  it('anchors under the user, named without the possessive', () => {
    expect(relativeHint({ name: 'my mom' }, 'u1')).toEqual({
      vertical: 'relative',
      id: 'mother',
      userId: 'u1',
      name: 'mom',
    });
  });

  it('reads the canonical form first ("Марией" → "Мария" style)', () => {
    expect(relativeHint({ name: 'маме', canonical: 'мама' }, 'u1')?.id).toBe('mother');
  });

  it('without a user there is nobody to scope it to', () => {
    expect(relativeHint({ name: 'Father' }, undefined)).toBeUndefined();
  });
});
