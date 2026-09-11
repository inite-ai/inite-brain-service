/**
 * What a datetime argument costs to declare.
 *
 * `z.string().datetime()` publishes its full calendar-aware regex into
 * the JSON Schema the MCP SDK puts in `tools/list`. Across brain's
 * surface that was 19 fields × ~200 tokens — better than a third of the
 * whole tool payload, re-sent on every request, spent on a pattern no
 * model reads and that `"format": "date-time"` already says.
 *
 * Two halves, and the second is the one that matters: the schema got
 * smaller AND nothing new is accepted. A cheaper schema that quietly
 * relaxed validation would be a worse bug than the cost it fixed.
 */
import { z } from 'zod';
import * as mini from 'zod/v4-mini';
import { isoDateTime } from '../src/mcp/iso-datetime';
import { countTokens } from '../src/common/token-counter';

/** The exact conversion the MCP SDK performs for tools/list. */
const publish = (shape: z.ZodRawShape): Record<string, unknown> =>
  mini.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as Record<string, unknown>;

const field = (shape: z.ZodRawShape) =>
  (publish(shape).properties as Record<string, unknown>).when as Record<string, unknown>;

describe('isoDateTime — the published schema', () => {
  it('is a type and a format, and nothing else', () => {
    expect(field({ when: isoDateTime() })).toEqual({ type: 'string', format: 'date-time' });
  });

  it('keeps describe() and optional() working', () => {
    // The call sites chain both; a helper that broke either would be
    // replaced by z.string().datetime() the next time someone edits a tool.
    const out = publish({ when: isoDateTime().describe('Inclusive lower bound').optional() });
    expect((out.properties as Record<string, unknown>).when).toEqual({
      type: 'string',
      format: 'date-time',
      description: 'Inclusive lower bound',
    });
    expect(out.required).toBeUndefined();
  });

  it('costs a fraction of what the regex did', () => {
    const before = countTokens(JSON.stringify(field({ when: z.string().datetime() })));
    const after = countTokens(JSON.stringify(field({ when: isoDateTime() })));
    expect(before).toBeGreaterThan(150);
    expect(after).toBeLessThan(20);
  });
});

describe('isoDateTime — what it accepts', () => {
  const strict = z.string().datetime();
  const ours = isoDateTime();
  const cases = [
    ['2026-09-10T12:00:00Z', true],
    ['2026-09-10T12:00:00.123Z', true],
    // Leap-year awareness survives: 2024 had a 29 February, 2026 does not.
    ['2024-02-29T00:00:00Z', true],
    ['2026-02-29T00:00:00Z', false],
    ['2026-09-10T12:00:00+02:00', false],
    ['2026-09-10', false],
    ['2026-13-01T00:00:00Z', false],
    ['last tuesday', false],
    ['', false],
  ] as const;

  it.each(cases)('%s → %s, same as z.string().datetime()', (value, expected) => {
    expect(ours.safeParse(value).success).toBe(expected);
    // The invariant, stated twice on purpose: identical to the validator
    // it replaced, not merely "close enough".
    expect(ours.safeParse(value).success).toBe(strict.safeParse(value).success);
  });
});
