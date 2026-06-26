import { Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SearchService } from '../search/search.service';
import { EntitiesService } from '../entities/entities.service';
import { IngestService } from '../ingest/ingest.service';
import { FactsService } from '../facts/facts.service';
import { MultiHopService } from '../multi-hop/multi-hop.service';
import { SynthesizeService } from '../synthesize/synthesize.service';
import { MemoryDiffService } from '../diff/memory-diff.service';
import { IngestPredictionService } from '../ingest/ingest-predictor.service';
import { SummarizeEntityService } from '../summarize-entity/summarize-entity.service';
import { ProceduralMemoryService } from '../procedural/procedural-memory.service';
import { CommunityService } from '../communities/community.service';
import { EmbedderService } from '../ai/embedder.service';
import { BrainScope } from '../auth/api-key.types';
import { registerCommunityTools } from './community-tools';
import { registerReadTools } from './read-tools';
import { registerProceduralReadTools } from './procedural-tools';
import { registerWriteTools, registerAdminTools } from './write-tools';

const MCP_SERVER_VERSION = '0.3.0';

const HEALTH_TOOLS = [
  'search_knowledge',
  'search_multi_hop',
  'synthesize',
  'memory_diff',
  'get_entity_profile',
  'get_entity_timeline',
  'summarize_entity',
  'get_competing_facts',
  'detect_contradiction',
  'find_related_entities',
  'match_procedure',
  'list_procedures',
  'search_communities',
  'list_communities',
  'find_entity_communities',
];

/**
 * Builds an MCP server instance bound to a single tenant + scope set.
 *
 * One McpServer per request — Streamable HTTP is request-scoped in stateless
 * mode, which suits multi-tenant per-request handling. We don't reuse server
 * instances across companies; that would require careful per-call swizzling
 * of the companyId, and the cost of constructing one is small relative to
 * the database round-trips inside each tool call.
 *
 * The per-scope tool registrations live in sibling modules
 * (read-tools / procedural-tools / community-tools / write-tools), each a
 * `registerXxxTools(server, companyId, deps)` free function. This file owns
 * the DI seam, the health probe, and the scope-gated wiring in buildServer.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  // This is the DI seam for every MCP-exposed surface; one
  // collaborator per tool family. Wrapping in a deps object would push
  // Nest's @Inject indirection into every call site without any
  // readability win — the constructor IS the manifest.
  /* eslint-disable-next-line max-params */
  constructor(
    private readonly search: SearchService,
    private readonly entities: EntitiesService,
    private readonly ingest: IngestService,
    private readonly facts: FactsService,
    private readonly multiHop: MultiHopService,
    private readonly synth: SynthesizeService,
    private readonly memoryDiff: MemoryDiffService,
    private readonly predictor: IngestPredictionService,
    private readonly summarizer: SummarizeEntityService,
    private readonly procedural: ProceduralMemoryService,
    private readonly communities: CommunityService,
    private readonly embedder: EmbedderService,
  ) {}

  /**
   * Unauthenticated health probe payload — surfaces version + the
   * read-baseline tool list so setup scripts can confirm the MCP
   * endpoint is reachable BEFORE the operator pastes the API key.
   * Write- and admin-scoped tools are NOT listed; callers verify those
   * exist by hitting the authenticated endpoint with the right scope.
   */
  health(): { ok: boolean; version: string; tools: string[]; embedder: string } {
    return {
      ok: true,
      version: MCP_SERVER_VERSION,
      tools: HEALTH_TOOLS,
      embedder: this.embedderDescription(),
    };
  }

  /**
   * Short human-readable embedding-model hint surfaced in MCP tool
   * descriptions + the health probe. The reverse — picking which
   * embedder a tenant uses based on the description string — is NOT
   * supported; this is purely informational.
   */
  private embedderDescription(): string {
    try {
      const stats = this.embedder.cacheStats();
      return `${stats.provider} (${this.embedder.getDimensions()}d)`;
    } catch {
      return 'unknown';
    }
  }

  buildServer(companyId: string, scopes: BrainScope[]): McpServer {
    const server = new McpServer({
      name: 'inite-brain-service',
      version: '0.1.0',
    });
    registerReadTools(server, companyId, scopes, {
      search: this.search,
      entities: this.entities,
      facts: this.facts,
      multiHop: this.multiHop,
      synth: this.synth,
      memoryDiff: this.memoryDiff,
      predictor: this.predictor,
      summarizer: this.summarizer,
      embedderDescription: () => this.embedderDescription(),
    });
    registerProceduralReadTools(server, companyId, {
      procedural: this.procedural,
    });
    registerCommunityTools(server, companyId, this.communities);
    if (scopes.includes('brain:write')) {
      registerWriteTools(server, companyId, {
        ingest: this.ingest,
        facts: this.facts,
        procedural: this.procedural,
      });
    }
    if (scopes.includes('brain:admin')) {
      registerAdminTools(server, companyId, { entities: this.entities });
    }
    return server;
  }
}
