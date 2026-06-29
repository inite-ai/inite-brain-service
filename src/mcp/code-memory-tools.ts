import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IngestService } from '../ingest/ingest.service';
import type { EntitiesService } from '../entities/entities.service';
import type { BrainScope } from '../auth/api-key.types';
import {
  CODE_MEMORY_KINDS,
  CODE_MEMORY_PREDICATE_IDS,
  codeMemoryKindOf,
  codeMemoryPredicateId,
} from '../ai/domain-packs';

/**
 * Code-memory MCP surface (Phase 0 — docs/roadmap/code-memory-domain.md).
 *
 * Remembers the non-derivable engineering "why" of a codebase — design
 * decisions, rationale, invariants, gotchas — as bitemporal typed facts
 * anchored to a CODE ANCHOR: a knowledge_entity addressed by a SCIP-style
 * symbol string (`code__<symbol>`), NOT line numbers, so the memory survives
 * edits. This is NOT a code index; structure (symbols / call graph) is derived
 * state recoverable from source and belongs to a code-search indexer.
 *
 * `why` is brain:read; `record_decision` is brain:write. Both are thin wrappers
 * over the existing ingest + entity-read paths — no new retrieval engine.
 */

/** Vertical used for code-anchor external refs. */
const CODE_VERTICAL = 'code';

export interface CodeMemoryReadDeps {
  entities: EntitiesService;
}

export interface CodeMemoryWriteDeps {
  ingest: IngestService;
}

export function registerCodeMemoryReadTools(opts: {
  server: McpServer;
  companyId: string;
  scopes: BrainScope[];
  deps: CodeMemoryReadDeps;
}): void {
  const { server, companyId, scopes, deps } = opts;
  server.registerTool(
    'why',
    {
      title: 'Recall the recorded "why" behind a code symbol',
      description:
        'Return the design decisions, rationale, invariants and gotchas recorded against a code anchor — the non-derivable engineering "why" a parser cannot recover from source. The anchor is a SCIP-style symbol string ("pkg/namespace/symbol") or a file path ("repo/path/file.ts"). Pass asOf to recall what was known at a past instant (bitemporal). Returns found:0 with empty memory when nothing is recorded.',
      inputSchema: {
        symbol: z
          .string()
          .describe('Code anchor — SCIP-style symbol or file path'),
        asOf: z
          .string()
          .datetime()
          .optional()
          .describe('Bitemporal cursor — recall what was known as of this instant'),
      },
    },
    async (args) => {
      const profile = await deps.entities.getProfileByExternalRef({
        companyId,
        vertical: CODE_VERTICAL,
        id: args.symbol,
        asOfRaw: args.asOf,
        scopes,
      });
      const codeIds = new Set(CODE_MEMORY_PREDICATE_IDS);
      const memory = (profile?.facts ?? []).filter((f) => codeIds.has(f.predicate));
      const out = {
        symbol: args.symbol,
        entityId: profile?.entityId ?? null,
        found: memory.length,
        memory: memory.map((f) => ({
          kind: codeMemoryKindOf(f.predicate),
          text: f.object,
          validFrom: f.validFrom,
          validUntil: f.validUntil,
          status: f.status,
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}

export function registerCodeMemoryWriteTools(opts: {
  server: McpServer;
  companyId: string;
  deps: CodeMemoryWriteDeps;
}): void {
  const { server, companyId, deps } = opts;
  server.registerTool(
    'record_decision',
    {
      title: 'Record a code-memory decision / rationale / invariant / gotcha',
      description:
        'Capture the non-derivable engineering "why" about a code location: a design decision, its rationale, an invariant that must hold, or a gotcha. Anchored to a SCIP-style symbol or file path (NOT line numbers — survives edits). Stored as a bitemporal typed fact: re-recording a `decided` / `invariant` for the same anchor SUPERSEDES the prior one (decision evolution over time), while `because` / `gotcha` accumulate. Attach commit / location for provenance.',
      inputSchema: {
        symbol: z
          .string()
          .describe('Code anchor — SCIP-style symbol or file path'),
        kind: z
          .enum(CODE_MEMORY_KINDS)
          .describe(
            'decided = a design decision (supersedes prior); because = rationale; invariant = a constraint that must hold (supersedes prior); gotcha = a non-obvious trap (accumulates)',
          ),
        text: z
          .string()
          .min(1)
          .max(2000)
          .describe('The decision / rationale / invariant / gotcha text'),
        commit: z
          .string()
          .optional()
          .describe('Commit SHA this was decided in (provenance)'),
        location: z
          .string()
          .optional()
          .describe('file:line provenance, e.g. src/x.ts:42'),
        validFrom: z
          .string()
          .datetime()
          .optional()
          .describe('When the decision took effect — defaults to now'),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    async (args) => {
      const out = await deps.ingest.ingestFact(companyId, {
        entityRef: { vertical: CODE_VERTICAL, id: args.symbol },
        predicate: codeMemoryPredicateId(args.kind),
        object: args.text,
        validFrom: args.validFrom ?? new Date().toISOString(),
        confidence: args.confidence,
        source: {
          vertical: CODE_VERTICAL,
          recorder: 'code_memory',
          // Provenance rides existing FactSource fields (persisted + returned
          // by the timeline). Phase 1 promotes this to triple-level PROV.
          ...(args.commit ? { eventId: args.commit } : {}),
          ...(args.location ? { messageId: args.location } : {}),
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}
