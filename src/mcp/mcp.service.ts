import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
import { MetricsService } from '../metrics/metrics.service';
import { registerReadTools, READ_RESOURCE_ACTIONS } from './read-tools';
import { registerProceduralReadTools } from './procedural-tools';
import { registerWriteTools, registerAdminTools } from './write-tools';
import { registerCodeMemoryReadTools, registerCodeMemoryWriteTools } from './code-memory-tools';
import { registerSourceReadTools } from './source-tools';
import { SourcesService } from '../sources/sources.service';
import { DocumentIngestService } from '../documents/document-ingest.service';
import { FeedbackService } from '../feedback/feedback.service';
import { PolicyGateService } from '../policy/policy-gate.service';
import { evaluateAction } from '../policy/policy-engine';
import { ACTIONS } from '../policy/action-registry';
import { ActionKind, PolicyContext } from '../policy/policy.types';
import { envFlagEnabled } from '../common/env-validation';
import { PACK_NAMESPACE_SEP } from '../ai/domain-packs';
import { PackToolsReaderService, type PackToolBinding } from './pack-tools-reader.service';
import { PackToolProxyService } from './pack-tool-proxy.service';
import { registerPackTools } from './pack-tools';
import { ToolObservationService } from '../outcomes/tool-observation.service';
import { toolObservationsEnabled } from '../common/tool-observation-flags';

const MCP_SERVER_VERSION = '0.3.0';

/**
 * Registration methods whose surface the resource/prompt gates patch.
 * registerTool has its own dedicated gates (byte-identical, above); this
 * covers registerResource today and a future registerPrompt with no code
 * change beyond an action map + a call site.
 */
type RegistrationMethod = 'registerResource' | 'registerPrompt';

/** A patched registration call returns a handle exposing remove(). */
type RemovableRegistrar = (...args: unknown[]) => { remove(): void };

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
    private readonly packToolsReader: PackToolsReaderService,
    private readonly packToolProxy: PackToolProxyService,
    @Optional() private readonly metrics?: MetricsService,
    // @Optional so positionally-constructed unit fixtures stay valid
    // (the OutcomesModule injection discipline).
    @Optional() private readonly toolObservations?: ToolObservationService,
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
  /**
   * Outermost handler wrapper — the MCP analogue of AllExceptionsFilter.
   * Without it a thrown error reaches the SDK, which serializes
   * error.message into the tool result verbatim: raw SurrealDB messages
   * carry record ids, index names, and (for type mismatches) FIELD
   * VALUES — data a brain:read key without read_pii must never see.
   *
   * Deliberate client-facing errors (HttpException < 500 — validation,
   * not-found, policy denials) pass through unchanged, matching what the
   * REST surface returns for the same inputs. Everything else is logged
   * in full with a correlation id and replaced by a generic message.
   *
   * Applied BEFORE applyPolicyToolGate patches registerTool, so the
   * error wrapper ends up outermost and also covers the gate itself.
   */
  private wrapToolErrors(server: McpServer): void {
    const raw = server.registerTool.bind(server);
    (server as unknown as { registerTool: unknown }).registerTool = (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown,
    ) =>
      raw(
        name as never,
        config as never,
        (async (...args: unknown[]) => {
          try {
            return await handler(...args);
          } catch (e) {
            if (e instanceof HttpException && e.getStatus() < 500) throw e;
            const ref = randomUUID().slice(0, 8);
            this.logger.error(`tool ${name} failed (ref ${ref}): ${(e as Error).stack ?? e}`);
            return {
              content: [
                {
                  type: 'text',
                  text: `internal error while running ${name} (ref ${ref})`,
                },
              ],
              isError: true,
            };
          }
        }) as never,
      );
  }

  // `kinds` carries the explicit read/write classification for tool
  // names OUTSIDE the static action registry (pack-declared tools:
  // query=read, external=write); registry names resolve as before.
  private applyPolicyToolGate(
    server: McpServer,
    policy: PolicyContext,
    kinds?: ReadonlyMap<string, ActionKind>,
  ): void {
    const raw = server.registerTool.bind(server);
    (server as unknown as { registerTool: unknown }).registerTool = (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown,
    ) => {
      const denied = evaluateAction(policy, name, kinds?.get(name)).decision === 'deny';
      const tool = raw(
        name as never,
        config as never,
        ((...args: unknown[]) => {
          this.policyGate.enforceToolAction(policy, name, kinds?.get(name));
          return handler(...args);
        }) as never,
      );
      // Enforce-denied tools unregister immediately: gone from
      // tools/list, and a blind tools/call gets the SDK's standard
      // unknown-tool error. Registered-then-removed (vs never
      // registered) only to keep the SDK's return type intact.
      if (denied) tool.remove();
      return tool;
    };
  }

  /**
   * RFC 9396 grant gate — the consent-time counterpart of the ABAC gate
   * above. Active only when the token carried inite_mcp_resource
   * entries: a tool stays registered iff its name is in the granted
   * union, or its kind is covered by a 'read'/'write' macro grant.
   * Applied AFTER the policy gate, and removals are independent, so
   * deny-overrides holds: a policy deny removes a tool the grant
   * allows, and a grant omission removes a tool the policy allows.
   */
  private applyGrantToolGate(
    server: McpServer,
    granted: readonly string[],
    kinds?: ReadonlyMap<string, ActionKind>,
  ): void {
    const grantSet = new Set(granted);
    const allows = (name: string): boolean => {
      if (grantSet.has(name)) return true;
      const kind = kinds?.get(name) ?? ACTIONS[name]?.kind;
      return kind !== undefined && grantSet.has(kind);
    };
    const raw = server.registerTool.bind(server);
    (server as unknown as { registerTool: unknown }).registerTool = (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown,
    ) => {
      const tool = raw(name as never, config as never, handler as never);
      if (!allows(name)) tool.remove();
      return tool;
    };
  }

  /**
   * Tool observation recorder (0111) — applied LAST in buildServer, so
   * it is the INNERMOST wrapper at call time (earlier-applied patches
   * are outermost): it runs INSIDE the policy + grant gates and the
   * error wrapper. Consequences, by construction:
   *   * a policy/grant-denied call never reaches this wrapper — denied
   *     calls produce NO observation row;
   *   * durationMs times the RAW handler, not the gates;
   *   * a thrown handler error is recorded ok:false and RETHROWN, so the
   *     outer wrapToolErrors keeps the client-facing error shape.
   * The recorder is fire-and-forget and content-free (digests only) —
   * see ToolObservationService. Only patched when the master flag is on
   * at server build (per-request), so off = byte-identical.
   */
  private applyToolObservation(server: McpServer, companyId: string): void {
    const recorder = this.toolObservations;
    if (!recorder) return;
    const raw = server.registerTool.bind(server);
    (server as unknown as { registerTool: unknown }).registerTool = (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown,
    ) =>
      raw(
        name as never,
        config as never,
        (async (...args: unknown[]) => {
          const started = Date.now();
          try {
            const result = await handler(...args);
            recorder.record(companyId, {
              tool: name,
              args: args[0],
              result,
              ok: (result as { isError?: boolean } | undefined)?.isError !== true,
              durationMs: Date.now() - started,
            });
            return result;
          } catch (e) {
            recorder.record(companyId, {
              tool: name,
              args: args[0],
              ok: false,
              durationMs: Date.now() - started,
            });
            throw e;
          }
        }) as never,
      );
  }

  /**
   * Error wrapper for the resource surface (and any future
   * registerPrompt) — the analogue of wrapToolErrors for registration
   * methods whose handler is the LAST argument and whose result carries
   * NO isError channel. Without it a thrown handler error reaches the
   * SDK, which serializes error.message into the JSON-RPC error verbatim:
   * the same raw SurrealDB leak (record ids, index names, FIELD VALUES)
   * that wrapToolErrors closes for tools — the read-side gap this fix
   * shuts.
   *
   * Deliberate client-facing errors (HttpException < 500 — not-found,
   * validation, policy denials) pass through unchanged, matching the tool
   * wrapper and the REST surface. Everything else is logged in full with
   * a correlation id and replaced by a generic message.
   *
   * Applied BEFORE the policy/grant gates patch the same method, so the
   * error wrapper ends up outermost and also covers the gate's enforce
   * call (a policy deny surfaces as its ForbiddenException, never raw).
   */
  private wrapRegistrationErrors({
    server,
    method,
  }: {
    server: McpServer;
    method: RegistrationMethod;
  }): void {
    const surface = method === 'registerResource' ? 'resource' : 'prompt';
    const bag = server as unknown as Record<RegistrationMethod, RemovableRegistrar>;
    const raw = bag[method].bind(server);
    (server as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1] as (...h: unknown[]) => unknown;
      const wrapped = async (...h: unknown[]): Promise<unknown> => {
        try {
          return await handler(...h);
        } catch (e) {
          if (e instanceof HttpException && e.getStatus() < 500) throw e;
          const ref = randomUUID().slice(0, 8);
          this.logger.error(`${surface} ${name} failed (ref ${ref}): ${(e as Error).stack ?? e}`);
          throw new Error(`internal error while reading ${surface} ${name} (ref ${ref})`);
        }
      };
      return raw(...args.slice(0, -1), wrapped);
    };
  }

  /**
   * ABAC gate for the resource surface (and any future registerPrompt) —
   * the exact analogue of applyPolicyToolGate. Resolves each
   * registration's policy action via `actionOf` (a resource reuses its
   * equivalent read tool's action), then mirrors the tool gate: an
   * enforce-denied registration is removed immediately (gone from
   * resources/list, a blind read gets the SDK's unknown-resource error),
   * and an allowed one gets a per-call wrapper that runs enforceToolAction
   * (emitting allow/would_deny decisions, throwing on an enforced deny)
   * before the handler.
   */
  private applyPolicyRegistrationGate({
    server,
    method,
    policy,
    actionOf,
  }: {
    server: McpServer;
    method: RegistrationMethod;
    policy: PolicyContext;
    actionOf: (name: string) => string;
  }): void {
    const bag = server as unknown as Record<RegistrationMethod, RemovableRegistrar>;
    const raw = bag[method].bind(server);
    (server as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const action = actionOf(args[0] as string);
      const handler = args[args.length - 1] as (...h: unknown[]) => unknown;
      const denied = evaluateAction(policy, action).decision === 'deny';
      const reg = raw(...args.slice(0, -1), (...h: unknown[]) => {
        this.policyGate.enforceToolAction(policy, action);
        return handler(...h);
      });
      // Enforce-denied resources unregister immediately, mirroring the
      // tool gate: gone from resources/list, blind read → unknown-resource.
      if (denied) reg.remove();
      return reg;
    };
  }

  /**
   * RFC 9396 grant gate for the resource surface (and any future
   * registerPrompt) — the analogue of applyGrantToolGate. A registration
   * stays iff its resolved action is in the granted union or its kind is
   * covered by a read/write macro grant. Applied AFTER the policy gate;
   * the two removals are independent, so deny-overrides holds exactly as
   * for tools (a policy deny removes what a grant allows, and a grant
   * omission removes what a policy allows).
   */
  private applyGrantRegistrationGate({
    server,
    method,
    granted,
    actionOf,
  }: {
    server: McpServer;
    method: RegistrationMethod;
    granted: readonly string[];
    actionOf: (name: string) => string;
  }): void {
    const grantSet = new Set(granted);
    const allows = (action: string): boolean => {
      if (grantSet.has(action)) return true;
      const kind = ACTIONS[action]?.kind;
      return kind !== undefined && grantSet.has(kind);
    };
    const bag = server as unknown as Record<RegistrationMethod, RemovableRegistrar>;
    const raw = bag[method].bind(server);
    (server as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const reg = raw(...args);
      if (!allows(actionOf(args[0] as string))) reg.remove();
      return reg;
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

  async buildServer(
    companyId: string,
    scopes: BrainScope[],
    caller?: {
      /**
       * Caller key hash — the feedback tool's one-vote-per-(fact,
       * actor) fence. Falls back to a per-tenant sentinel for callers
       * that don't thread it (unit fixtures).
       */
      actorKeyHash?: string | undefined;
      /**
       * Resolved ABAC context from ApiKeyGuard; undefined = no
       * policies attached, tool surface identical to pre-ABAC.
       */
      policy?: PolicyContext | undefined;
      /**
       * Per-pack key binding (ApiKeyRecord.packIds): a bound key sees
       * only its packs' declared tools; absent = every consented pack.
       */
      packIds?: string[] | undefined;
      /** Acting client (agent) identity — provenance attribution. */
      actorId?: string | undefined;
      /**
       * RFC 9396 inite_mcp_resource grant (ApiKeyRecord.mcpGrantedActions):
       * undefined = gate inactive; [] = granted nothing (all tools removed).
       */
      mcpGrantedActions?: string[] | undefined;
    },
  ): Promise<McpServer> {
    const actorKeyHash = caller?.actorKeyHash;
    const policy = caller?.policy;
    // Bindings are fetched BEFORE the wrappers so the ABAC gate knows
    // each pack tool's read/write kind at registration time.
    const packBindings = await this.packToolBindings(companyId, caller?.packIds);
    const packToolKinds = new Map<string, ActionKind>();
    for (const b of packBindings) {
      for (const t of b.tools) {
        packToolKinds.set(
          `${b.packId}${PACK_NAMESPACE_SEP}${t.name}`,
          t.kind === 'query' ? 'read' : 'write',
        );
      }
    }
    const server = new McpServer({
      name: 'inite-brain-service',
      version: MCP_SERVER_VERSION,
    });
    // A resource read resolves to its equivalent read tool's action, so a
    // grant/policy over get_entity_profile governs the brain://entity/<id>
    // resource identically. An unmapped resource name falls through to
    // itself → write-kind → fail-closed under any restriction.
    const resourceActionOf = (name: string): string => READ_RESOURCE_ACTIONS.get(name) ?? name;
    this.wrapToolErrors(server);
    // Resources have no isError result channel; gate + error-wrap them
    // with the SAME machinery as tools so a grant/policy that strips the
    // entity-read tools also strips the entity resources, and a raw DB
    // error never leaks through a resource read.
    this.wrapRegistrationErrors({ server, method: 'registerResource' });
    if (policy) {
      this.applyPolicyToolGate(server, policy, packToolKinds);
      this.applyPolicyRegistrationGate({
        server,
        method: 'registerResource',
        policy,
        actionOf: resourceActionOf,
      });
    }
    if (caller?.mcpGrantedActions !== undefined) {
      this.applyGrantToolGate(server, caller.mcpGrantedActions, packToolKinds);
      this.applyGrantRegistrationGate({
        server,
        method: 'registerResource',
        granted: caller.mcpGrantedActions,
        actionOf: resourceActionOf,
      });
    }
    // Applied LAST = INNERMOST: inside policy + grant gates (denied
    // calls record nothing) and inside wrapToolErrors (thrown errors are
    // recorded ok:false then rethrown to keep the client shape).
    if (toolObservationsEnabled()) {
      this.applyToolObservation(server, companyId);
    }
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
      scopes,
    });
    registerCommunityTools(server, companyId, {
      communities: this.communities,
      scopes,
    });
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
        actorId: caller?.actorId,
        deps: {
          ingest: this.ingest,
          facts: this.facts,
          procedural: this.procedural,
          documents: this.documents,
          feedback: this.feedback,
          metrics: this.metrics,
        },
      });
      registerCodeMemoryWriteTools({
        server,
        companyId,
        deps: { ingest: this.ingest },
      });
    }
    if (scopes.includes('brain:admin')) {
      registerAdminTools(server, companyId, {
        entities: this.entities,
        actorKeyHash: actorKeyHash ?? `mcp:${companyId}`,
      });
    }
    registerPackTools({
      server,
      companyId,
      scopes,
      bindings: packBindings,
      deps: {
        search: this.search,
        facts: this.facts,
        proxy: this.packToolProxy,
      },
    });
    return server;
  }

  /**
   * Consented pack tool bindings for this request — [] when the master
   * flag is off (no DB round-trip on the pre-existing surface), fenced
   * to the key's packIds binding when one is present.
   */
  private async packToolBindings(
    companyId: string,
    packIds?: string[],
  ): Promise<PackToolBinding[]> {
    if (!envFlagEnabled(process.env.MCP_PACK_TOOLS_ENABLED)) return [];
    const bindings = await this.packToolsReader.installedPackTools(companyId);
    return packIds ? bindings.filter((b) => packIds.includes(b.packId)) : bindings;
  }
}
