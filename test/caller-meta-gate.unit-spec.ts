import { BadRequestException } from '@nestjs/common';
import {
  gateCallerMeta,
  INVALID_META,
  LEGACY_INVALID_METADATA,
  sourceMetaStrict,
} from '../src/common/caller-meta-gate';

/**
 * One gate, one code. The fact route answered `invalid_metadata` and the
 * document route `invalid_meta` for the same check; both now carry
 * `code: invalid_meta`, and the fact route keeps its old `error` value as
 * a deprecated alias. Strict is the default: only an explicit `0`/`false`
 * turns a rejection into a warning.
 */
describe('caller meta gate', () => {
  const saved = process.env.SOURCE_META_STRICT;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOURCE_META_STRICT;
    else process.env.SOURCE_META_STRICT = saved;
  });

  const bad = { conversationId: 'c1', channel: 'web' };

  function rejection(fn: () => unknown): Record<string, unknown> {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return (err as BadRequestException).getResponse() as Record<string, unknown>;
    }
    throw new Error('expected a 400');
  }

  it('is strict when the flag is unset', () => {
    delete process.env.SOURCE_META_STRICT;
    expect(sourceMetaStrict()).toBe(true);
    const body = rejection(() => gateCallerMeta(bad, { warn: jest.fn() }));
    expect(body).toMatchObject({ error: INVALID_META, code: INVALID_META });
    expect(body.issues).toEqual([expect.stringContaining("'conversationId'")]);
  });

  it('keeps the legacy error value on the fact route, with the canonical code beside it', () => {
    delete process.env.SOURCE_META_STRICT;
    const body = rejection(() =>
      gateCallerMeta(bad, { warn: jest.fn(), legacyError: LEGACY_INVALID_METADATA }),
    );
    expect(body).toMatchObject({ error: 'invalid_metadata', code: 'invalid_meta' });
  });

  it.each(['0', 'false'])('warns and keeps the clean remainder when SOURCE_META_STRICT=%s', (v) => {
    process.env.SOURCE_META_STRICT = v;
    const warn = jest.fn();
    expect(gateCallerMeta(bad, { warn })).toEqual({ channel: 'web' });
    expect(warn).toHaveBeenCalledWith(1, expect.stringContaining("'conversationId'"));
  });

  it('passes clean meta through and leaves absent meta absent', () => {
    delete process.env.SOURCE_META_STRICT;
    const warn = jest.fn();
    expect(gateCallerMeta({ channel: 'telegram', direction: 'inbound' }, { warn })).toEqual({
      channel: 'telegram',
      direction: 'inbound',
    });
    expect(gateCallerMeta(undefined, { warn })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
