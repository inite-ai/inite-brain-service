import { Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { envFlagEnabled } from '../common/env-validation';
import {
  composePredicateId,
  PACK_NAMESPACE_SEP,
  type PackExternalToolSpec,
  type PackQueryToolSpec,
  type PackToolParam,
} from '../ai/domain-packs';
import type { SearchService } from '../search/search.service';
import type { FactsService } from '../facts/facts.service';
import type { BrainScope } from '../auth/api-key.types';
import type { PackToolBinding } from './pack-tools-reader.service';
import type { PackToolProxyService } from './pack-tool-proxy.service';
import {
  PARAM_DESCRIPTION_CAP,
  renderPackToolDescription,
  renderPackToolTitle,
  sanitizePackText,
} from './pack-tool-render';

/**
 * Registration of pack-declared MCP tools (docs/mcp-pack-tools.md) on a
 * per-request server — same free-function shape as read-tools.ts.
 * Called AFTER the wrapToolErrors / applyPolicyToolGate patches, so
 * every pack tool inherits error sanitization and the ABAC gate.
 *
 * The security-relevant invariant lives HERE, not in the manifest:
 * query predicates are SERVER-COMPUTED from the pack's own vocabulary
 * (spec localIds → composePredicateId, or all pack predicates), and the
 * caller-facing input schemas are fixed — a pack chooses names and
 * descriptions, never the query shape.
 */
export interface PackToolsDeps {
  search: SearchService;
  facts: FactsService;
  /** Absent = external tools cannot be served and are skipped. */
  proxy?: PackToolProxyService;
}

const logger = new Logger('PackTools');

export interface RegisterPackToolsOptions {
  server: McpServer;
  companyId: string;
  scopes: BrainScope[];
  bindings: PackToolBinding[];
  deps: PackToolsDeps;
}

export function registerPackTools(opts: RegisterPackToolsOptions): void {
  if (!envFlagEnabled(process.env.MCP_PACK_TOOLS_ENABLED)) return;
  // Sub-flags, independently toggleable: query tools default ON under
  // the master flag; external tools default OFF (outbound calls are a
  // bigger operator decision than tenant-local reads).
  const queryEnabled = envFlagEnabled(
    process.env.MCP_PACK_QUERY_TOOLS_ENABLED ?? '1',
  );
  const externalEnabled = envFlagEnabled(
    process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED,
  );
  const seen = new Set<string>();
  for (const binding of opts.bindings) {
    for (const tool of binding.tools) {
      const fullName = `${binding.packId}${PACK_NAMESPACE_SEP}${tool.name}`;
      // Defensive — the validator already rejects in-pack duplicates and
      // cross-pack names can't collide (distinct packId prefix).
      if (seen.has(fullName)) {
        logger.warn(`duplicate pack tool name ${fullName} — skipped`);
        continue;
      }
      seen.add(fullName);
      if (tool.kind === 'query' && queryEnabled) {
        registerQueryTool({ ...opts, binding, tool, fullName });
      } else if (tool.kind === 'external' && externalEnabled && opts.deps.proxy) {
        registerExternalTool({ ...opts, binding, tool, fullName });
      }
    }
  }
}

interface QueryToolContext extends RegisterPackToolsOptions {
  binding: PackToolBinding;
  tool: PackQueryToolSpec;
  fullName: string;
}

function registerQueryTool(ctx: QueryToolContext): void {
  if (ctx.tool.query.surface === 'search') registerSearchQueryTool(ctx);
  else registerFactsByPredicateTool(ctx);
}

function registerSearchQueryTool(ctx: QueryToolContext): void {
  const { server, companyId, scopes, binding, tool, fullName, deps } = ctx;
  // Locked server-side: spec localIds → namespaced ids, or the whole
  // pack vocabulary when the spec names none. Never caller-supplied.
  const predicates = tool.query.predicates?.length
    ? tool.query.predicates.map((l) => composePredicateId(binding.packId, l))
    : [...binding.namespacedPredicates];
  server.registerTool(
    fullName,
    {
      title: renderPackToolTitle(tool),
      description: renderPackToolDescription({
        packId: binding.packId,
        version: binding.version,
        tool,
      }),
      inputSchema: {
        query: z.string().min(1).max(500).describe('Natural-language query'),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args: { query: string; limit?: number }) => {
      const limit = Math.min(args.limit ?? tool.query.defaultLimit ?? 10, 20);
      const out = await deps.search.search(
        companyId,
        {
          query: args.query,
          limit,
          predicates,
          minConfidence: tool.query.minConfidence,
        },
        scopes,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}

function registerFactsByPredicateTool(ctx: QueryToolContext): void {
  const { server, companyId, scopes, binding, tool, fullName, deps } = ctx;
  // Validator guarantees predicates is a non-empty localId list here;
  // the enum makes any predicate OUTSIDE the declared set a schema
  // error before the handler runs.
  const locals = tool.query.predicates as [string, ...string[]];
  server.registerTool(
    fullName,
    {
      title: renderPackToolTitle(tool),
      description: renderPackToolDescription({
        packId: binding.packId,
        version: binding.version,
        tool,
      }),
      inputSchema: {
        predicate: z
          .enum(locals)
          .describe("One of the pack's own predicates"),
        entity: z
          .string()
          .max(200)
          .optional()
          .describe('Scope to one entity (knowledge_entity:… or short id)'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args: { predicate: string; entity?: string; limit?: number }) => {
      const out = await deps.facts.listByPredicate({
        companyId,
        predicate: composePredicateId(binding.packId, args.predicate),
        entityIdRaw: args.entity,
        limit: Math.min(args.limit ?? tool.query.defaultLimit ?? 10, 50),
        scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}

interface ExternalToolContext extends RegisterPackToolsOptions {
  binding: PackToolBinding;
  tool: PackExternalToolSpec;
  fullName: string;
}

function registerExternalTool(ctx: ExternalToolContext): void {
  const { server, binding, tool, fullName, deps } = ctx;
  const inputSchema: Record<string, z.ZodTypeAny> = {};
  for (const p of tool.params ?? []) {
    inputSchema[p.name] = paramSchema(p);
  }
  // Only declared params are forwarded — the SDK's schema parse strips
  // extras, but the handler is also called directly in unit fixtures.
  const declared = new Set((tool.params ?? []).map((p) => p.name));
  server.registerTool(
    fullName,
    {
      title: renderPackToolTitle(tool),
      description: renderPackToolDescription({
        packId: binding.packId,
        version: binding.version,
        tool,
      }),
      inputSchema,
    },
    async (args: Record<string, unknown>) => {
      const forwarded = Object.fromEntries(
        Object.entries(args ?? {}).filter(([k]) => declared.has(k)),
      );
      const out = await deps.proxy!.call({ binding, tool, args: forwarded });
      return {
        content: out.content,
        ...(out.structuredContent
          ? { structuredContent: out.structuredContent as any }
          : {}),
      };
    },
  );
}

/** Declared param → zod schema. Enum wins over maxLength for strings;
 *  a plain string is capped (author's maxLength or the 2000 ceiling). */
function paramSchema(p: PackToolParam): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  if (p.type === 'string') {
    schema = p.enum?.length
      ? z.enum(p.enum as [string, ...string[]])
      : z.string().max(p.maxLength ?? 2_000);
  } else if (p.type === 'number') {
    schema = z.number();
  } else {
    schema = z.boolean();
  }
  if (p.description) {
    schema = schema.describe(
      sanitizePackText(p.description, PARAM_DESCRIPTION_CAP),
    );
  }
  return p.required ? schema : schema.optional();
}
