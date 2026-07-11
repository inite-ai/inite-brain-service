/**
 * originKeyOf is the JS mirror of fn::origin_key_of (0050) ∘
 * fn::source_key_of (0022). Corroboration keys off it, so its parity
 * with the stored fns is load-bearing: a drift would make the preflight
 * mis-detect "same claim, different origin".
 */
import { originKeyOf } from '../src/ingest/predictor-internals';

describe('originKeyOf — parity with fn::origin_key_of', () => {
  it('prefers an explicit originKey (document path stamps doc:<hash>)', () => {
    expect(originKeyOf({ vertical: 'notes', recorder: 'sync', originKey: 'doc:abc' })).toBe(
      'doc:abc',
    );
  });

  it('falls back to vertical:recorder when no originKey', () => {
    expect(originKeyOf({ vertical: 'rent', recorder: 'bot' })).toBe('rent:bot');
  });

  it('uses the _ recorder sentinel when recorder is absent/empty', () => {
    expect(originKeyOf({ vertical: 'rent' })).toBe('rent:_');
    expect(originKeyOf({ vertical: 'rent', recorder: '' })).toBe('rent:_');
  });

  it('returns system_seed for null / non-object / vertical-less source', () => {
    expect(originKeyOf(undefined)).toBe('system_seed');
    expect(originKeyOf(null)).toBe('system_seed');
    expect(originKeyOf('nope')).toBe('system_seed');
    expect(originKeyOf({ recorder: 'bot' })).toBe('system_seed');
  });

  it('distinguishes two recorders on the same vertical (corroboration axis)', () => {
    expect(originKeyOf({ vertical: 'rent', recorder: 'a' })).not.toBe(
      originKeyOf({ vertical: 'rent', recorder: 'b' }),
    );
  });
});
