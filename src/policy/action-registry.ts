import { SetMetadata } from '@nestjs/common';
import { ActionKind, CompiledActionRule } from './policy.types';

/**
 * The flat action namespace ABAC policies gate. MCP tool names are used
 * verbatim; REST endpoints reuse the equivalent MCP tool name where one
 * exists (POST /v1/search and the search_knowledge tool are the same
 * action) and get `rest.*` names otherwise. Controllers opt in via
 * @PolicyAction('name'); undecorated guarded routes fall back to the
 * auto-name `"<METHOD> <path>"` with kind inferred from the HTTP verb
 * (GET → read, else write) so a default-deny posture has no holes.
 *
 * family is UI grouping only — the engine reads kind (readonly macro).
 */
export type ActionFamily =
  | 'mcp_read'
  | 'mcp_write'
  | 'mcp_community'
  | 'mcp_procedural'
  | 'mcp_source'
  | 'rest';

export interface ActionSpec {
  kind: ActionKind;
  family: ActionFamily;
  title?: string;
}

export const ACTIONS: Record<string, ActionSpec> = {
  // MCP read tools (also the REST search/entity surface)
  search_knowledge: { kind: 'read', family: 'mcp_read', title: 'Search knowledge' },
  search_multi_hop: { kind: 'read', family: 'mcp_read', title: 'Multi-hop search' },
  graph_retrieve: { kind: 'read', family: 'mcp_read', title: 'Graph-first retrieval' },
  synthesize: { kind: 'read', family: 'mcp_read', title: 'Synthesize answer' },
  agent_qa: { kind: 'read', family: 'mcp_read', title: 'Agent-in-loop answer' },
  memory_diff: { kind: 'read', family: 'mcp_read', title: 'Memory diff' },
  get_entity_profile: { kind: 'read', family: 'mcp_read', title: 'Entity profile' },
  get_entity_timeline: { kind: 'read', family: 'mcp_read', title: 'Entity timeline' },
  autocomplete_entities: {
    kind: 'read',
    family: 'mcp_read',
    title: 'Entity name autocomplete',
  },
  get_competing_facts: { kind: 'read', family: 'mcp_read', title: 'Competing facts' },
  summarize_entity: { kind: 'read', family: 'mcp_read', title: 'Summarize entity' },
  detect_contradiction: { kind: 'read', family: 'mcp_read', title: 'Detect contradiction' },
  why: { kind: 'read', family: 'mcp_read', title: 'Code-memory why' },
  recall_decisions: { kind: 'read', family: 'mcp_read', title: 'Recall decisions' },

  // MCP write tools
  record_fact: { kind: 'write', family: 'mcp_write', title: 'Record fact' },
  retract_fact: { kind: 'write', family: 'mcp_write', title: 'Retract fact' },
  link_entities: { kind: 'write', family: 'mcp_write', title: 'Link entities' },
  forget_entity: { kind: 'write', family: 'mcp_write', title: 'Forget entity' },
  ingest_document: { kind: 'write', family: 'mcp_write', title: 'Ingest document' },
  record_decision: { kind: 'write', family: 'mcp_write', title: 'Record decision' },
  record_feedback: { kind: 'write', family: 'mcp_write', title: 'Record retrieval feedback' },

  // Communities / graph neighbourhood
  list_communities: { kind: 'read', family: 'mcp_community', title: 'List communities' },
  search_communities: { kind: 'read', family: 'mcp_community', title: 'Search communities' },
  find_entity_communities: { kind: 'read', family: 'mcp_community', title: 'Entity communities' },
  find_related_entities: { kind: 'read', family: 'mcp_community', title: 'Related entities' },

  // Procedural memory
  list_procedures: { kind: 'read', family: 'mcp_procedural', title: 'List procedures' },
  match_procedure: { kind: 'read', family: 'mcp_procedural', title: 'Match procedure' },
  record_procedure: { kind: 'write', family: 'mcp_procedural', title: 'Record procedure' },
  retire_procedure: { kind: 'write', family: 'mcp_procedural', title: 'Retire procedure' },

  // Sources
  get_source_reputation: { kind: 'read', family: 'mcp_source', title: 'Source reputation' },

  // REST-only actions
  'rest.users.forget': { kind: 'write', family: 'rest', title: 'GDPR user forget' },
  'rest.ingest.mention': { kind: 'write', family: 'rest', title: 'Ingest mention' },
  'rest.documents.get': { kind: 'read', family: 'rest', title: 'Get document' },
  'rest.documents.candidates': { kind: 'read', family: 'rest', title: 'List candidates' },
  'rest.documents.commit': { kind: 'write', family: 'rest', title: 'Commit candidates' },
  'rest.documents.stage_candidates': { kind: 'write', family: 'rest', title: 'Stage external candidates' },
  'rest.documents.purge_content': { kind: 'write', family: 'rest', title: 'Purge document content' },
  'rest.indexer.work': { kind: 'read', family: 'rest', title: 'List indexer work' },
  'rest.indexer.claim': { kind: 'write', family: 'rest', title: 'Claim indexer work' },
  'rest.indexer.heartbeat': { kind: 'write', family: 'rest', title: 'Heartbeat indexer claim' },
  'rest.indexer.content': { kind: 'read', family: 'rest', title: 'Read work document content' },
  'rest.indexer.fail': { kind: 'write', family: 'rest', title: 'Release indexer work' },
  'rest.artifacts.get': { kind: 'read', family: 'rest', title: 'Get artifact' },
  'rest.artifacts.recompile': { kind: 'write', family: 'rest', title: 'Recompile artifact' },
  'rest.stats.overview': { kind: 'read', family: 'rest', title: 'Stats overview' },
  'rest.dreams.run': { kind: 'write', family: 'rest', title: 'Run dreams pass' },
  'rest.sources.list': { kind: 'read', family: 'rest', title: 'List source reputations' },

  // Registry marketplace (docs/domain-packs.md "Marketplace")
  'rest.registry.pricing.set': { kind: 'write', family: 'rest', title: 'Set pack pricing' },
  'rest.registry.pricing.clear': { kind: 'write', family: 'rest', title: 'Clear pack pricing' },
  'rest.registry.feature': { kind: 'write', family: 'rest', title: 'Feature pack' },
  'rest.registry.unfeature': { kind: 'write', family: 'rest', title: 'Unfeature pack' },
  'rest.registry.publisher.upsert': { kind: 'write', family: 'rest', title: 'Upsert publisher profile' },
  'rest.registry.publisher.get': { kind: 'read', family: 'rest', title: 'Get publisher page' },
  // Raw-substrate driver v1: the L0 episode substrate as a contract.
  'rest.episodes.list': { kind: 'read', family: 'rest', title: 'List episodes' },
  'rest.episodes.export': { kind: 'read', family: 'rest', title: 'Export episodes (NDJSON)' },
  'rest.projections.list': { kind: 'read', family: 'rest', title: 'List derived projections' },
  'rest.projections.rebuild': { kind: 'admin', family: 'rest', title: 'Rebuild a derived projection' },
  'rest.registry.checkout': { kind: 'write', family: 'rest', title: 'Create pack checkout session' },
};

/**
 * Kind of an action name. Registered names use their spec; auto-named
 * fallbacks ("GET /v1/...") infer from the verb. Unknown non-fallback
 * names are treated as write — the conservative bucket for the
 * readonly macro.
 */
export function actionKind(action: string): ActionKind {
  const spec = ACTIONS[action];
  if (spec) return spec.kind;
  if (action.startsWith('GET ')) return 'read';
  return 'write';
}

/** Does one compiled action rule cover this action? */
export function actionRuleMatches(
  rule: CompiledActionRule,
  action: string,
  kind: ActionKind,
): boolean {
  if (rule.names.has(action)) return true;
  if (rule.macros.has('@all')) return true;
  if (rule.macros.has('@readonly') && kind === 'read') return true;
  if (rule.macros.has('@write') && kind === 'write') return true;
  return false;
}

export const POLICY_ACTION_KEY = 'policyAction';

/**
 * Names a controller handler in the ABAC action namespace. Mirrors
 * RequireScopes (SetMetadata + reflector read in ApiKeyGuard).
 */
export const PolicyAction = (action: string) =>
  SetMetadata(POLICY_ACTION_KEY, action);
