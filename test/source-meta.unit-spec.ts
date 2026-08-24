import { sanitizeSourceMeta, SOURCE_META_MAX_KEYS } from '../src/policy/source-meta';

describe('sanitizeSourceMeta', () => {
  it('keeps snake_case keys with scalar values', () => {
    const { meta, dropped } = sanitizeSourceMeta({
      data_class: 'pii',
      priority: 3,
      reviewed: true,
    });
    expect(meta).toEqual({ data_class: 'pii', priority: 3, reviewed: true });
    expect(dropped).toHaveLength(0);
  });

  it('drops bad keys, non-scalar and oversized values with reasons', () => {
    const { meta, dropped } = sanitizeSourceMeta({
      'Bad Key': 'x',
      nested: { deep: true },
      long: 'x'.repeat(300),
      list: ['a'],
      nan: NaN,
      ok: 'fine',
    });
    expect(meta).toEqual({ ok: 'fine' });
    expect(dropped).toHaveLength(5);
  });

  it('caps at SOURCE_META_MAX_KEYS entries', () => {
    const raw = Object.fromEntries(
      Array.from({ length: SOURCE_META_MAX_KEYS + 4 }, (_, i) => [`k_${i}`, 'v']),
    );
    const { meta, dropped } = sanitizeSourceMeta(raw);
    expect(Object.keys(meta ?? {})).toHaveLength(SOURCE_META_MAX_KEYS);
    expect(dropped).toHaveLength(4);
  });

  it('handles null/undefined/non-object inputs', () => {
    expect(sanitizeSourceMeta(undefined)).toEqual({ dropped: [] });
    expect(sanitizeSourceMeta(null)).toEqual({ dropped: [] });
    expect(sanitizeSourceMeta('str').dropped).toHaveLength(1);
    expect(sanitizeSourceMeta(['a']).dropped).toHaveLength(1);
    expect(sanitizeSourceMeta({}).meta).toBeUndefined();
  });
});
