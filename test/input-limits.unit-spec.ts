import {
  LLM_INPUT_LIMITS,
  clampLlmInputText,
} from '../src/common/input-limits';

describe('clampLlmInputText', () => {
  it('trims whitespace and reports not-truncated for short input', () => {
    const out = clampLlmInputText('  hello  ', 'query');
    expect(out).toEqual({ value: 'hello', truncated: false });
  });

  it('returns empty + not-truncated for whitespace-only input', () => {
    expect(clampLlmInputText('   ', 'mentionText')).toEqual({
      value: '',
      truncated: false,
    });
  });

  it('truncates at the configured ceiling for each kind', () => {
    for (const kind of Object.keys(LLM_INPUT_LIMITS) as Array<
      keyof typeof LLM_INPUT_LIMITS
    >) {
      const limit = LLM_INPUT_LIMITS[kind];
      const oversize = 'x'.repeat(limit + 50);
      const out = clampLlmInputText(oversize, kind);
      expect(out.truncated).toBe(true);
      expect(out.value.length).toBe(limit);
    }
  });

  it('does not flag truncation when the trimmed length is exactly the limit', () => {
    const limit = LLM_INPUT_LIMITS.query;
    const padded = ' ' + 'x'.repeat(limit) + ' ';
    const out = clampLlmInputText(padded, 'query');
    expect(out.truncated).toBe(false);
    expect(out.value.length).toBe(limit);
  });
});
