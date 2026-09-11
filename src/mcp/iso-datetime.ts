import { z } from 'zod';

/**
 * An ISO-8601 datetime argument that does not cost 200 tokens to declare.
 *
 * `z.string().datetime()` emits its full calendar-aware regex into the
 * JSON Schema — leap years, month lengths, the lot — and the MCP SDK
 * publishes that verbatim in `tools/list`. Measured on brain's surface:
 * 19 datetime fields × ~200 tokens ≈ 3 800 tokens, better than a third
 * of the whole tool payload, spent on a pattern no model reads and that
 * `"format": "date-time"` already communicates. It is re-sent on every
 * request, because the server is stateless.
 *
 * The refinement delegates to zod's own `.datetime()` validator, so what
 * is ACCEPTED is byte-identical to before — offsets still rejected,
 * date-only still rejected — while `.meta()` keeps the one annotation
 * that helps the model. Schema output is exactly:
 *
 *   { "type": "string", "format": "date-time" }
 *
 * Pinned by test/mcp-tool-schema-cost.unit-spec.ts, which asserts both
 * halves: the shrunken schema and the unchanged accept/reject set.
 */
const STRICT_ISO = z.string().datetime();

export function isoDateTime() {
  return z
    .string()
    .refine((value) => STRICT_ISO.safeParse(value).success, {
      message: 'expected an ISO-8601 datetime, e.g. 2026-09-10T12:00:00Z',
    })
    .meta({ format: 'date-time' });
}
