import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ACTIONS } from '../policy/action-registry';
import type { ActionKind } from '../policy/policy.types';

/**
 * MCP tool annotations, derived — never hand-written per tool.
 *
 * A client decides how much to trust a call from these hints: Claude's
 * directory refuses a connector whose tools lack `title` plus
 * `readOnlyHint`/`destructiveHint`, and a client that auto-approves reads
 * does it off `readOnlyHint`. Brain already classifies every tool for the
 * ABAC gate (the action registry's `kind`), so the hints are read from
 * that one table; a second, hand-kept list would drift from it the first
 * time someone added a tool and forgot one of the two.
 *
 * The defaults the spec assumes are the unsafe ones (`destructiveHint`
 * and `openWorldHint` both true when absent), so every hint is stated.
 */

/**
 * Writes that remove or close something. Every other write adds: a new
 * fact supersedes an old one through the conflict resolver, it does not
 * erase it, so `record_fact` is not destructive in the spec's sense.
 */
const DESTRUCTIVE = new Set(['forget_entity', 'retract_fact', 'retire_procedure', 'run_tool']);

export interface ToolClassification {
  /**
   * The tool's top-level `title`. Not repeated inside `annotations`: the
   * spec's annotation title is the legacy spelling of the same thing, and
   * every byte here rides in every `tools/list`.
   */
  title: string;
  annotations: ToolAnnotations;
  /** False when the name is in no table and the conservative default was used. */
  known: boolean;
}

function humanize(name: string): string {
  const words = name.replace(/[_:.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The hints for one tool. `packKinds` carries pack-declared tools, which
 * the registry cannot know: a `query` tool reads brain's graph, an
 * `external` one acts on a system outside brain — open world, and treated
 * as destructive because brain cannot vouch for what it does there.
 */
export function classifyTool(
  name: string,
  opts: {
    title?: string | undefined;
    packKinds?: ReadonlyMap<string, ActionKind> | undefined;
  } = {},
): ToolClassification {
  const packKind = opts.packKinds?.get(name);
  const kind = ACTIONS[name]?.kind ?? packKind;
  const title = opts.title ?? ACTIONS[name]?.title ?? humanize(name);
  if (kind === undefined) {
    return {
      title,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      known: false,
    };
  }
  const external = packKind !== undefined && packKind !== 'read';
  if (kind === 'read') {
    return { title, annotations: { readOnlyHint: true, openWorldHint: false }, known: true };
  }
  return {
    title,
    annotations: {
      readOnlyHint: false,
      destructiveHint: external || DESTRUCTIVE.has(name),
      openWorldHint: external,
    },
    known: true,
  };
}

/**
 * Patches `registerTool` so every registration carries its derived
 * annotations and a `title`. A tool's own `annotations` win field by
 * field; the derivation only fills what the registration left out.
 */
export function applyToolAnnotations(
  server: McpServer,
  packKinds?: ReadonlyMap<string, ActionKind>,
): void {
  const raw = server.registerTool.bind(server);
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: { title?: string; annotations?: ToolAnnotations } & Record<string, unknown>,
    handler: unknown,
  ) => {
    const { title, annotations } = classifyTool(name, { title: config?.title, packKinds });
    return raw(
      name as never,
      {
        ...config,
        title,
        annotations: { ...annotations, ...config?.annotations },
      } as never,
      handler as never,
    );
  };
}
