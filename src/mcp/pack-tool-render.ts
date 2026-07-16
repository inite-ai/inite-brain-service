import type { PackToolSpec } from '../ai/domain-packs';

/**
 * Rendering of pack-authored tool text for the MCP surface
 * (docs/mcp-pack-tools.md). Pack manifests are third-party input that
 * ends up verbatim in an agent's context window, so every author string
 * is sanitized (Unicode normalization, control/bidi/zero-width strip,
 * whitespace collapse, hard cap) and every tool description gets a
 * server-owned preamble stating its provenance and effect FIRST — the
 * one part of the description a pack cannot spoof. Pure module.
 */

export const TITLE_CAP = 80;
export const DESCRIPTION_CAP = 500;
export const PARAM_DESCRIPTION_CAP = 200;

// Control chars (C0/C1 minus \t\n\r, which the whitespace collapse
// turns into single spaces), bidi overrides/isolates (U+202A-E,
// U+2066-69, U+200E/F, U+061C), zero-width + word joiners (U+200B-D,
// U+2060-64, U+FEFF) — the classes used to smuggle invisible or
// re-ordered instructions into tool descriptions.
const STRIP = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
    '\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

/** NFC-normalize, strip control/bidi/zero-width, collapse whitespace,
 *  trim, cap. Idempotent; returns '' for non-strings. */
export function sanitizePackText(s: unknown, cap: number): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFC')
    .replace(STRIP, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * Full tool description: server preamble (always first, kind-specific)
 * + the sanitized author description.
 */
export function renderPackToolDescription(opts: {
  packId: string;
  version: string;
  tool: PackToolSpec;
}): string {
  const effect =
    opts.tool.kind === 'external'
      ? 'calls an external endpoint operated by the pack publisher'
      : "reads this tenant's knowledge graph";
  const preamble = `[third-party tool from domain pack "${opts.packId}" v${opts.version}; ${effect}] `;
  return preamble + sanitizePackText(opts.tool.description, DESCRIPTION_CAP);
}

/** Sanitized author title, or undefined when the pack declared none. */
export function renderPackToolTitle(tool: PackToolSpec): string | undefined {
  if (tool.title === undefined) return undefined;
  const title = sanitizePackText(tool.title, TITLE_CAP);
  return title.length > 0 ? title : undefined;
}
