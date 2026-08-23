import type { PackToolSpec } from '../ai/domain-packs';
import { sanitizePackText } from '../common/text-sanitizer';

/**
 * Rendering of pack-authored tool text for the MCP surface
 * (docs/mcp-pack-tools.md). Pack manifests are third-party input that
 * ends up verbatim in an agent's context window, so every author string
 * is sanitized (Unicode normalization, control/bidi/zero-width strip,
 * whitespace collapse, hard cap) and every tool description gets a
 * server-owned preamble stating its provenance and effect FIRST — the
 * one part of the description a pack cannot spoof. Pure module.
 *
 * The strip/normalize primitive now lives in the shared
 * `common/text-sanitizer` (so ingest paths can apply the same defense);
 * `sanitizePackText` is re-exported here unchanged for existing importers.
 */

export const TITLE_CAP = 80;
export const DESCRIPTION_CAP = 500;
export const PARAM_DESCRIPTION_CAP = 200;

export { sanitizePackText };

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
