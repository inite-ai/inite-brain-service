/**
 * The MCP tool input schemas, pinned.
 *
 * Agents cache `tools/list`, and SDKs generate types from it; a property
 * an agent was told it could send must keep being accepted. The other MCP
 * specs pin names, scopes, annotations, descriptions and schema SIZE, but
 * not the schemas themselves — a removed argument or a newly required one
 * shipped green. This spec compares the live surface (a real `tools/list`,
 * see scripts/mcp-schemas.ts) with test/golden/mcp-tool-schemas.json:
 *
 *   - a breaking delta (tool removed or renamed, property removed, property
 *     newly required, type narrowed, enum value removed) fails with what to
 *     do instead — or how to break it on purpose;
 *   - any other delta (new tool, new optional property, wording) fails only
 *     until `pnpm mcp:schemas` regenerates the golden, so it stays exact and
 *     the PR diff shows the contract change.
 *
 * The comparison rules are scripts/ci/schema-compat.ts, unit-tested in
 * test/schema-compat.unit-spec.ts. CI runs the same comparison on the
 * golden itself, base branch vs PR (scripts/ci/openapi-breaking.ts --mcp).
 */
import { readFileSync } from 'fs';
import { liveToolSchemas, MCP_SCHEMA_GOLDEN_PATH, serializeGolden } from '../scripts/mcp-schemas';
import { compareToolSchemas } from '../scripts/ci/schema-compat';

const goldenText = readFileSync(MCP_SCHEMA_GOLDEN_PATH, 'utf8');
const golden = JSON.parse(goldenText) as Record<string, unknown>;

const bullets = (lines: string[]): string => lines.map((l) => `  - ${l}`).join('\n');

describe('MCP tool input schemas vs test/golden/mcp-tool-schemas.json', () => {
  let live: Record<string, unknown>;

  beforeAll(async () => {
    live = await liveToolSchemas();
  });

  it('has no breaking change', () => {
    const { breaking } = compareToolSchemas(golden, live);
    if (breaking.length > 0) {
      throw new Error(
        `Breaking change(s) to the MCP tool schemas:\n${bullets(breaking)}\n\n` +
          'Connected agents and generated SDKs code against these. Prefer an additive change: a new ' +
          'optional property or a new tool, the old one marked deprecated in its description and ' +
          'kept for at least one minor release (AGENTS.md, "Evolving data and contracts").\n' +
          'To break it deliberately: run `pnpm mcp:schemas` to update the golden, and give the PR a ' +
          'breaking Conventional Commit title with `!` (e.g. `feat(mcp)!: …`). CI compares the ' +
          'golden against the base branch and lets a break through only under such a title.',
      );
    }
  });

  it('matches the golden exactly (an additive change needs `pnpm mcp:schemas`)', () => {
    const { drift } = compareToolSchemas(golden, live);
    if (drift.length > 0 || goldenText !== serializeGolden(live)) {
      throw new Error(
        `The MCP tool schemas changed without a golden update:\n${bullets(drift)}\n\n` +
          'These changes are not breaking. Run `pnpm mcp:schemas` and commit ' +
          'test/golden/mcp-tool-schemas.json.',
      );
    }
  });

  it('covers the widest surface: every scope and every family switch', () => {
    // Spot-checks of the gated families, so a regression in the generator's
    // pinned env cannot quietly shrink what the golden protects.
    for (const name of [
      'search_knowledge',
      'record_fact',
      'forget_entity',
      'read_media',
      'upload_media',
      'take_memory_work',
      'ingest_document',
      'record_feedback',
      'rename_workspace',
      'relationship_context',
    ]) {
      expect(Object.keys(live)).toContain(name);
    }
  });
});
