import { LRUCache } from '../src/common/lru-cache';

describe('LRUCache', () => {
  it.each([0, -1, NaN])('rejects capacity %p', (capacity) => {
    expect(() => new LRUCache<string, number>(capacity)).toThrow(/positive integer/);
  });

  it('evicts the least recently inserted key when full', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
  });

  it('get() refreshes a key, so the next insert evicts the other one', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
  });

  it('set() on an existing key updates and refreshes it without evicting', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10);
    expect(c.size).toBe(2);
    expect(c.get('a')).toBe(10);
    expect(c.has('b')).toBe(true);
    // 'a' is now most recent, so 'b' is the one to go.
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
  });

  it('get() on a missing key returns undefined', () => {
    const c = new LRUCache<string, number>(2);
    expect(c.get('missing')).toBeUndefined();
  });

  it('has / delete / size / clear behave as a map', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(2);
    expect(c.delete('a')).toBe(true);
    expect(c.delete('a')).toBe(false);
    expect(c.has('a')).toBe(false);
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('b')).toBeUndefined();
  });

  it('a deleted key frees its slot, so the next insert evicts nothing', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.delete('a');
    c.set('c', 3);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });
});
