import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtractionWorkService } from '../documents/extraction-work.service';
import type { DreamsWorkService } from '../dreams/dreams-work.service';
import type { SceneSummaryWorkService } from '../admin/scene-summary-work.service';
import type { BeliefStatementWorkService } from '../admin/belief-statement-work.service';
import type { PredicateSemanticsWorkService } from '../ai/predicate-semantics-work.service';
import { pinUserScope } from '../auth/user-scope';
import { extractionSource } from '../common/extraction-source';
import type { HarnessWork } from '../common/harness-work';
import {
  HARNESS_WORK_KINDS,
  WORK_TOKEN_MAX_CHARS,
  verifyWorkToken,
  type HarnessWorkKind,
  type WorkTokenPayload,
} from '../common/harness-work-token';
import { asStructuredContent } from './structured';

export interface HarnessWorkToolDeps {
  extraction?: ExtractionWorkService | undefined;
  predicates?: PredicateSemanticsWorkService | undefined;
  dreams?: DreamsWorkService | undefined;
  /** Resolved lazily: these live in AdminModule, which imports McpModule. */
  scenes?: (() => SceneSummaryWorkService | undefined) | undefined;
  beliefs?: (() => BeliefStatementWorkService | undefined) | undefined;
}

/**
 * Harness mode (#819): everything the server's own model did in the
 * background — reading documents into facts, judging same-entity and
 * competing-fact pairs, summarising scenes — handed to the connected
 * agent in batches, offered in that order (attributes, then facts: the
 * judges and summaries read them). Registered only when EXTRACTION_SOURCE=harness —
 * a server-mode tenant's tools/list does not pay for tools it never needs.
 * brain:write (the caller gates registration). Called from BOTH
 * McpService.buildServer and gated-catalogue.ts.
 */
export function registerHarnessWorkTools(p: {
  server: McpServer;
  companyId: string;
  deps: HarnessWorkToolDeps;
}): void {
  if (extractionSource() !== 'harness') return;
  const { server, companyId, deps } = p;

  server.registerTool(
    'take_memory_work',
    {
      title: 'Take memory work',
      description:
        'Returns the next batch of work the memory left for a connected model, in this order: predicate_semantics (new attributes: one value at a time or several), extraction (stored documents to read into facts), entity_match (pairs of entities that may be one thing), fact_conflict (pairs of competing facts), fact_corroboration (pairs of facts that may state one thing twice), scene_summary (conversation scenes to summarise), belief_statement (remembered states to phrase as a sentence). A batch holds the systemPrompt and userContent the server model would have been sent, the JSON schema of the reply, how many items it covers, and the signed work token its reply is submitted with, valid until expiresAt. Returns {work: null} when nothing is waiting.',
      inputSchema: {
        userId: z
          .string()
          .max(200)
          .optional()
          .describe("Per-user memory scope: only this user's memory. Omit for tenant-global"),
        kinds: z
          .array(z.enum(HARNESS_WORK_KINDS))
          .optional()
          .describe('Only these kinds; all by default'),
        maxItems: z.number().int().min(1).max(64).optional(),
      },
    },
    async (args) => {
      const userId = pinUserScope(args.userId);
      const kinds = args.kinds ?? [...HARNESS_WORK_KINDS];
      let work: HarnessWork | null = null;
      for (const kind of HARNESS_WORK_KINDS) {
        if (!kinds.includes(kind)) continue;
        work = await take(deps, kind, { companyId, userId, max: args.maxItems });
        if (work) break;
      }
      const out = { work };
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  server.registerTool(
    'submit_memory_work',
    {
      title: 'Submit memory work',
      description:
        "Stores a model's JSON reply to a batch of memory work, with its work token. The server applies it with its own code: extraction replies are grounded against the text it handed out, resolved and committed; attribute classifications update the vocabulary; verdicts link identical entities or supersede the losing fact; scene summaries and belief sentences are validated and written. An item whose evidence changed since it was handed out is skipped and counted stale, so a batch applied twice changes nothing the second time. Returns counts for the batch. A bad, expired or foreign token is refused.",
      inputSchema: {
        token: z.string().min(1).max(WORK_TOKEN_MAX_CHARS),
        result: z.record(z.string(), z.unknown()).describe('The reply object, matching the schema'),
      },
    },
    async (args) => {
      const payload = verifiedWorkToken(companyId, args.token);
      const out = await submit(deps, companyId, { payload, result: args.result });
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

async function take(
  deps: HarnessWorkToolDeps,
  kind: HarnessWorkKind,
  {
    companyId,
    ...opts
  }: { companyId: string; userId: string | undefined; max: number | undefined },
): Promise<HarnessWork | null> {
  switch (kind) {
    case 'extraction':
      return deps.extraction
        ? deps.extraction.take(companyId, { userId: opts.userId, maxDocs: opts.max })
        : null;
    case 'entity_match':
      return deps.dreams ? deps.dreams.takeEntityMatch(companyId, opts) : null;
    case 'fact_conflict':
      return deps.dreams ? deps.dreams.takeFactConflict(companyId, opts) : null;
    case 'fact_corroboration':
      return deps.dreams ? deps.dreams.takeFactCorroboration(companyId, opts) : null;
    case 'predicate_semantics':
      return deps.predicates ? deps.predicates.take(companyId, opts) : null;
    case 'scene_summary':
      return deps.scenes?.()?.take(companyId, opts) ?? null;
    case 'belief_statement':
      return deps.beliefs?.()?.take(companyId, opts) ?? null;
  }
}

async function submit(
  deps: HarnessWorkToolDeps,
  companyId: string,
  { payload, result }: { payload: WorkTokenPayload; result: unknown },
): Promise<object> {
  switch (payload.t) {
    case 'extraction':
      return need(deps.extraction).submit(companyId, payload, result);
    case 'entity_match':
    case 'fact_conflict':
    case 'fact_corroboration':
      return need(deps.dreams).submit(companyId, payload, result);
    case 'predicate_semantics':
      return need(deps.predicates).submit(companyId, payload, result);
    case 'scene_summary':
      return need(deps.scenes?.()).submit(companyId, payload, result);
    case 'belief_statement':
      return need(deps.beliefs?.()).submit(companyId, payload, result);
  }
}

function need<T>(service: T | undefined): T {
  if (!service) throw new NotFoundException('this kind of memory work is not available here');
  return service;
}

/** The token's payload, or a 4xx. */
export function verifiedWorkToken(companyId: string, token: string): WorkTokenPayload {
  const verdict = verifyWorkToken(token);
  if (verdict.state === 'invalid') throw new BadRequestException('invalid work token');
  if (verdict.payload.c !== companyId) {
    throw new ForbiddenException('this work token belongs to another workspace');
  }
  if (verdict.state === 'expired') {
    throw new BadRequestException('work token expired; take the work again');
  }
  if (pinUserScope(verdict.payload.u) !== verdict.payload.u) {
    throw new ForbiddenException('this work token belongs to another user scope');
  }
  return verdict.payload;
}
