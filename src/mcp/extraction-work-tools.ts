import { NotFoundException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtractionWorkService } from '../documents/extraction-work.service';
import { extractionSource } from '../common/extraction-source';
import { asStructuredContent } from './structured';

export interface ExtractionWorkToolDeps {
  work?: ExtractionWorkService | undefined;
}

/**
 * Harness mode (#819): the connected agent reads captured documents with
 * its own model. Registered only when EXTRACTION_SOURCE=harness — a
 * server-mode tenant's tools/list does not pay for two tools it never
 * needs. brain:write (the caller gates registration). Called from BOTH
 * McpService.buildServer and gated-catalogue.ts.
 */
export function registerExtractionWorkTools(p: {
  server: McpServer;
  companyId: string;
  deps: ExtractionWorkToolDeps;
}): void {
  if (extractionSource() !== 'harness') return;
  const { server, companyId, deps } = p;
  const service = (): ExtractionWorkService => {
    if (!deps.work) throw new NotFoundException('harness extraction is not available here');
    return deps.work;
  };

  server.registerTool(
    'take_extraction_work',
    {
      title: 'Take extraction work',
      description:
        'Claims the oldest group of stored documents still waiting to be read into facts and returns what the server extractor would send a model for it: systemPrompt, userContent (memory context plus the text), the JSON schema of the reply, and the signed work token its reply is submitted with, valid until expiresAt. Returns {work: null} when nothing is waiting.',
      inputSchema: {
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: take only this user's documents. Omit for tenant-global",
          ),
        maxDocuments: z.number().int().min(1).max(64).optional(),
      },
    },
    async (args) => {
      const work = await service().take(companyId, {
        userId: args.userId,
        maxDocs: args.maxDocuments,
      });
      const out = { work };
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  server.registerTool(
    'submit_extraction',
    {
      title: 'Submit extraction',
      description:
        'Stores the JSON reply of a model to a claimed extraction prompt, with its work token: the server checks every value against the text it handed out (grounding), resolves entities, stages and commits the facts. Returns counts {documents, facts, entities, edges, committed}. A bad, expired or foreign token is refused; a token works once.',
      inputSchema: {
        token: z.string().min(1).max(16_384),
        result: z.record(z.string(), z.unknown()).describe('The reply object, matching the schema'),
      },
    },
    async (args) => {
      const out = await service().submit(companyId, args.token, args.result);
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}
