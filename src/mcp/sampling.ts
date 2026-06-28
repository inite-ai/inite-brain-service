import { Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntitiesService } from '../entities/entities.service';
import type { SummarizeEntityService } from '../summarize-entity/summarize-entity.service';
import type { BrainScope } from '../auth/api-key.types';

/**
 * Phase 4.3 — MCP sampling fallback path.
 *
 * Brain asks the connected client (Claude Desktop / agent runtime) to
 * write a one-line briefing using its own LLM via
 * `server.server.createMessage`. Useful when the operator self-hosts
 * brain without an OpenAI key — the client IS the LLM source.
 *
 * Capability detection: client must have advertised `sampling: {}`
 * during initialize. If it didn't, we fall through to the
 * deterministic template so the tool still answers.
 *
 * No cache here — sampling calls are expensive but the client already
 * chooses its model + budget; double-caching would race with the
 * client's own context.
 */
const log = new Logger('SamplingSummarize');

export interface SamplingSummarizeResult {
  entityId: string;
  summary: string;
  factsConsidered: number;
  sampledBy: 'client_llm' | 'local_template';
  modelUsed?: string;
  asOf?: string;
}

export interface SummarizeViaClientSamplingOptions {
  deps: {
    entities: EntitiesService;
    summarizer: SummarizeEntityService;
  };
  server: McpServer;
  companyId: string;
  entityId: string;
  asOf: string | undefined;
  scopes: BrainScope[];
}

export async function summarizeViaClientSampling({
  deps,
  server,
  companyId,
  entityId,
  asOf,
  scopes,
}: SummarizeViaClientSamplingOptions): Promise<SamplingSummarizeResult> {
  const profile = await deps.entities.getProfile({
    companyId,
    entityIdRaw: entityId,
    asOfRaw: asOf,
    scopes,
  });
  const caps = server.server.getClientCapabilities();
  if (!caps?.sampling) {
    return fallback({ summarizer: deps.summarizer, companyId, entityId, asOf, scopes });
  }
  const topFacts = profile.facts
    .filter((f) => f.status === 'active' || f.status === 'competing')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8)
    .map((f) => `- ${f.predicate}: ${f.object}`)
    .join('\n');
  const prompt =
    `Write a single-sentence briefing (≤ 25 words) about this entity. ` +
    `No preamble, no markdown, no quotes — just the sentence.\n\n` +
    `Name: ${profile.canonicalName}\nType: ${profile.type}\n` +
    `Top facts:\n${topFacts || '(none)'}`;
  try {
    const res = await server.server.createMessage({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: prompt },
        },
      ],
      maxTokens: 200,
      systemPrompt:
        'You write concise factual one-line briefings about people / companies / things from a knowledge graph.',
    });
    const text =
      res.content && res.content.type === 'text'
        ? res.content.text.trim()
        : '';
    return {
      entityId: profile.entityId,
      summary: text || `${profile.canonicalName} (${profile.type})`,
      factsConsidered: profile.facts.length,
      sampledBy: 'client_llm',
      modelUsed: res.model,
      asOf,
    };
  } catch (err) {
    log.warn(
      `summarize_entity sampling fell back to template: ${(err as Error).message}`,
    );
    return fallback({ summarizer: deps.summarizer, companyId, entityId, asOf, scopes });
  }
}

async function fallback({
  summarizer,
  companyId,
  entityId,
  asOf,
  scopes,
}: {
  summarizer: SummarizeEntityService;
  companyId: string;
  entityId: string;
  asOf: string | undefined;
  scopes: BrainScope[];
}): Promise<SamplingSummarizeResult> {
  const out = await summarizer.summarize(
    companyId,
    { entityId, asOf, styleHint: 'neutral' },
    scopes,
  );
  return {
    entityId: out.entityId,
    summary: out.summary,
    factsConsidered: out.factsConsidered,
    sampledBy: 'local_template',
    asOf: out.asOf,
  };
}
