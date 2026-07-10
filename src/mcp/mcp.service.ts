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
import { CodeMemorySearchService } from '../code-memory/code-memory-search.service';
import { EmbedderService } from '../ai/embedder.service';
import { BrainScope } from '../auth/api-key.types';
import { registerCommunityTools } from './community-tools';
import { registerReadTools } from './read-tools';
import { registerProceduralReadTools } from './procedural-tools';
import { registerWriteTools, registerAdminTools } from './write-tools';
import {
  registerCodeMemoryReadTools,
  registerCodeMemoryWriteTools,
} from './code-memory-tools';
import { registerSourceReadTools } from './source-tools';
import { SourcesService } from '../sources/sources.service';
import { DocumentIngestService } from '../documents/document-ingest.service';
import { FeedbackService } from '../feedback/feedback.service';
import { PolicyGateService } from '../policy/policy-gate.service';
import { evaluateAction } from '../policy/policy-engine';
import { PolicyContext } from '../policy/policy.types';

const MCP_SERVER_VERSION = '0.3.0';

const HEALTH_TOOLS = [
  'search_knowledge',
  'search_multi_hop',
  'graph_retrieve',
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
  'why',
  'recall_decisions',
  'get_source_reputation',
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
    private readonly codeSearch: CodeMemorySearchService,
    private readonly sources: SourcesService,
    private readonly embedder: EmbedderService,
    private readonly documents: DocumentIngestService,
    private readonly feedback: FeedbackService,
    private readonly policyGate: PolicyGateService,
  ) {}

  /**
   * ABAC tool gate: wraps server.registerTool so every subsequent
   * registration (all six tool families) is policy-checked without
   * touching the tool files. An enforce-denied tool is not registered
   * at all — it disappears from tools/list and a tools/call gets the
   * SDK's standard unknown-tool error. Allowed tools get a per-call
   * wrapper that emits allow/would_deny decisions (report_only
   * observability).
   */
  private applyPolicyToolGate(server: McpServer, policy: PolicyContext): void {
    const raw = server.registerTool.bind(server);
    (server as McpServer & { registerTool: unknown }).registerTool = (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown,
    ) => {
      const denied = evaluateAction(policy, name).decision === 'deny';
      const tool = raw(name as never, config as never, ((...args: unknown[]) => {
        this.policyGate.enforceAction(policy, name);
        return handler(...args);
      }) as never);
      // Enforce-denied tools unregister immediately: gone from
      // tools/list, and a blind tools/call gets the SDK's standard
      // unknown-tool error. Registered-then-removed (vs never
      // registered) only to keep the SDK's return type intact.
      if (denied) tool.remove();
      return tool;
    };
  }

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

  buildServer(
    companyId: string,
    scopes: BrainScope[],
    caller?: {
      /**
       * Caller key hash — the feedback tool's one-vote-per-(fact,
       * actor) fence. Falls back to a per-tenant sentinel for callers
       * that don't thread it (unit fixtures).
       */
      actorKeyHash?: string;
      /**
       * Resolved ABAC context from ApiKeyGuard; undefined = no
       * policies attached, tool surface identical to pre-ABAC.
       */
      policy?: PolicyContext;
    },
  ): McpServer {
    const actorKeyHash = caller?.actorKeyHash;
    const policy = caller?.policy;
    const server = new McpServer({
      name: 'inite-brain-service',
      version: '0.1.0',
    });
    if (policy) this.applyPolicyToolGate(server, policy);
    registerReadTools({
      server,
      companyId,
      scopes,
      deps: {
        search: this.search,
        entities: this.entities,
        facts: this.facts,
        multiHop: this.multiHop,
        synth: this.synth,
        memoryDiff: this.memoryDiff,
        predictor: this.predictor,
        summarizer: this.summarizer,
        embedderDescription: () => this.embedderDescription(),
      },
    });
    registerProceduralReadTools(server, companyId, {
      procedural: this.procedural,
    });
    registerCommunityTools(server, companyId, this.communities);
    registerCodeMemoryReadTools({
      server,
      companyId,
      scopes,
      deps: { entities: this.entities, codeSearch: this.codeSearch },
    });
    registerSourceReadTools({
      server,
      companyId,
      deps: { sources: this.sources },
    });
    if (scopes.includes('brain:write')) {
      registerWriteTools({
        server,
        companyId,
        scopes,
        actorKeyHash: actorKeyHash ?? `mcp:${companyId}`,
        deps: {
          ingest: this.ingest,
          facts: this.facts,
          procedural: this.procedural,
          documents: this.documents,
          feedback: this.feedback,
        },
      });
      registerCodeMemoryWriteTools({
        server,
        companyId,
        deps: { ingest: this.ingest },
      });
    }
    if (scopes.includes('brain:admin')) {
      registerAdminTools(server, companyId, { entities: this.entities });
    }
    return server;
  }
}
