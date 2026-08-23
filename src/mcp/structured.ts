/**
 * Coerce a typed tool-result object into MCP's `structuredContent` shape.
 *
 * The MCP SDK types a tool result's `structuredContent` field as
 * `Record<string, unknown>` — arbitrary JSON. Brain's tool handlers return
 * concrete domain objects (SearchResult, EntityProfile, …) that ARE plain
 * JSON (they're `JSON.stringify`d into the sibling text block on the same
 * return), but their declared interfaces carry no string index signature,
 * so TypeScript won't structurally accept them as `Record<string, unknown>`.
 *
 * This is the single sanctioned spot for that safe object→record coercion:
 * a value of a known object type is, at runtime, exactly a string-keyed
 * record of unknown-typed values. Routing every call site through here
 * keeps the coercion named, documented, and out of the handlers — instead
 * of an `as any` (or a scattered `as unknown as …`) per tool.
 */
export function asStructuredContent(out: object): Record<string, unknown> {
  return out as unknown as Record<string, unknown>;
}
