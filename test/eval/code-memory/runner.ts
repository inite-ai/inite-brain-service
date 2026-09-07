/**
 * Code-memory battery runner — drives EVERYTHING through the real
 * wire, mirroring the memory-fitness / state-transitions /
 * domain-packs siblings:
 *
 *  - REST  GET /v1/admin/predicates      (phase 0: assert the BUILTIN
 *          code_memory predicates are seeded — the pack is builtin, so
 *          there is NO install; the install path rejects the builtin
 *          id by design and this runner never calls it)
 *  - REST  POST /v1/ingest/mention       (corpus turns, per-user scoped)
 *  - MCP   tools/list / search_knowledge / get_entity_timeline /
 *          get_fact_provenance / synthesize / why / record_decision
 *
 * Scoring is fully mechanical (see scorers.ts) — no LLM judge. The
 * serving calls cost normal model spend on the stand; the battery
 * itself spends nothing on judging.
 *
 * Run: pnpm eval:code-memory   (see README.md for stand flags)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HttpBrainClient } from '../http-brain-client';
import { interleaveRoundRobin } from '../memory-fitness/interleave';
import { walkProvenance } from '../memory-fitness/scorers';
import { checkHistorySequence, scoreServe, type HistoryEvent } from '../state-transitions/scorers';
import { findExactPredicateFact, findNamespacedTools, type HitLike } from '../domain-packs/scorers';
import { buildChecks, buildTurns, CM, CORPUS_VERTICAL } from './corpus';
import {
  checkBuiltinPredicates,
  checkEntityFactGroups,
  checkNoForbiddenFact,
  checkSupersession,
  checkWhyRoundtrip,
  resolveModuleEntity,
  type FactText,
  type PredicateLike,
  type WhyLike,
} from './scorers';
import type {
  BuiltinVocabCheck,
  Check,
  CheckKind,
  CheckResult,
  CrossEntityCheck,
  FlagTransitionCheck,
  IntentionGuardCheck,
  LiteralHarvestCheck,
  McpRoundtripCheck,
  PackVocabCheck,
  Scorecard,
  ServeCheck,
  SupersessionCheck,
  Tally,
  TraceProvenanceCheck,
} from './types';

/** Provenance-walk budget per check (sibling round-robin interleave). */
const PROVENANCE_CANDIDATE_CAP = 12;

/** How many search hits get their timeline walked per transition check. */
const HISTORY_ENTITY_CAP = 6;

/** Wall-clock gap around the supersession asOf cursor (ms). */
const SUPERSESSION_GAP_MS = 2_000;

// ── configuration ───────────────────────────────────────────────────

interface Config {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  userId: string;
  runId: string;
  guardrails: 'strict' | 'lenient' | 'off';
  skipIngest: boolean;
  reportDir: string;
}

function loadConfig(): Config {
  const baseUrl = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL;
  const apiKey = process.env.BRAIN_API_KEY;
  const companyId = process.env.BRAIN_COMPANY_ID;
  if (baseUrl === undefined || baseUrl === '') {
    console.error(
      [
        'code-memory: BRAIN_BASE_URL is not set — nothing to run against.',
        'This battery drives a LIVE brain stand over MCP + REST (it needs a booted',
        'service and its OpenAI key) and is intentionally never run in CI.',
        '',
        'Required env:',
        '  BRAIN_BASE_URL   e.g. http://localhost:3000  (BRAIN_URL also accepted)',
        '  BRAIN_API_KEY    tenant M2M key with brain:read + brain:write + brain:admin',
        '                   (phase 0 reads /v1/admin/predicates; record_decision',
        '                   needs brain:write)',
        '  BRAIN_COMPANY_ID tenant id — use a FRESH tenant per run (see README.md)',
        '',
        'NOTE: code_memory is a BUILTIN pack — its predicates are seeded into every',
        'tenant at bootstrap and the install path REJECTS the builtin id, so this',
        'runner performs no install (that absence is itself under test: k01).',
        '',
        'Optional env: CMEV_USER_ID, CMEV_RUN_ID, CMEV_GUARDRAILS',
        '(strict|lenient|off, default strict), CMEV_SKIP_INGEST=1 (re-ask an',
        'already-ingested run — requires the same CMEV_RUN_ID), CMEV_REPORT_DIR.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (apiKey === undefined || apiKey === '') {
    console.error('code-memory: BRAIN_API_KEY is not set.');
    process.exit(1);
  }
  if (companyId === undefined || companyId === '') {
    console.error('code-memory: BRAIN_COMPANY_ID is not set.');
    process.exit(1);
  }
  const guardrailsRaw = process.env.CMEV_GUARDRAILS ?? 'strict';
  if (guardrailsRaw !== 'strict' && guardrailsRaw !== 'lenient' && guardrailsRaw !== 'off') {
    console.error('code-memory: CMEV_GUARDRAILS must be strict|lenient|off.');
    process.exit(1);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    companyId,
    userId: process.env.CMEV_USER_ID ?? 'cm-agent',
    runId: process.env.CMEV_RUN_ID ?? `cm${Date.now().toString(36)}`,
    guardrails: guardrailsRaw,
    skipIngest: process.env.CMEV_SKIP_INGEST === '1',
    reportDir: process.env.CMEV_REPORT_DIR ?? join('var', 'code-memory'),
  };
}

// ── small utilities ─────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry on throttle (HTTP 429) — mention ingest and the MCP route are rate-capped. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err);
      if (attempt < 12 && /429|too many requests/i.test(msg)) {
        console.error(`  [throttled] ${label} — waiting 6.5s (attempt ${attempt})`);
        await sleep(6_500);
        continue;
      }
      throw err;
    }
  }
}

/** Run-scoped conversation id — makes re-runs non-colliding by construction. */
const convId = (cfg: Config, key: string): string => `${cfg.runId}-${key}`;

const messageId = (cfg: Config, key: string, turn: number): string =>
  `${convId(cfg, key)}-t${String(turn).padStart(2, '0')}`;

/** Run-scoped code anchor — MCP writes never collide across runs. */
const saltedAnchor = (cfg: Config, anchor: string): string => `${cfg.runId}:${anchor}`;

// ── REST (raw, non-throwing — phase 0 branches on the status) ───────

interface RestResult<T> {
  status: number;
  json: T | null;
}

async function restRaw<T>(cfg: Config, method: 'GET', path: string): Promise<RestResult<T>> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return { status: res.status, json: null };
  return { status: res.status, json: (await res.json()) as T };
}

// ── MCP ─────────────────────────────────────────────────────────────

interface ToolCallShape {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

function textOf(res: ToolCallShape): string | null {
  if (!Array.isArray(res.content)) return null;
  for (const item of res.content) {
    if (
      item !== null &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      return (item as { text: string }).text;
    }
  }
  return null;
}

async function connectMcp(cfg: Config): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${cfg.baseUrl}/mcp/${cfg.companyId}`),
    { requestInit: { headers: { Authorization: `Bearer ${cfg.apiKey}` } } },
  );
  const client = new McpClient({ name: 'code-memory-battery', version: '1.0.0' });
  // Same @modelcontextprotocol/sdk .d.ts self-inconsistency the server
  // side bridges in src/mcp/mcp.controller.ts: under
  // exactOptionalPropertyTypes the concrete transport class no longer
  // structurally satisfies its own Transport interface. The runtime
  // value genuinely is a valid Transport; this asserts the SDK's own
  // contract, not our types.
  await client.connect(transport as Transport);
  return client;
}

async function callTool<T>(
  mcp: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const raw = (await withRetry(name, () =>
    mcp.callTool({ name, arguments: args }),
  )) as ToolCallShape;
  const text = textOf(raw);
  if (raw.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${text ?? '(no error text)'}`);
  }
  if (text !== null) return JSON.parse(text) as T;
  if (raw.structuredContent !== undefined) return raw.structuredContent as T;
  throw new Error(`MCP tool ${name} returned neither text nor structuredContent`);
}

// Local wire shapes — only the fields the scorers consume.
interface SearchHit {
  entityId: string;
  canonicalName?: string;
  facts?: Array<{ factId: string; predicate: string; object: string }>;
}
interface SearchOut {
  results?: SearchHit[];
}
interface SynthOut {
  answer: string | null;
  reason?: string;
}
interface TimelineOut {
  events?: Array<{ type: string; at: string; predicate?: string; object?: string }>;
}
interface ProvenanceOut {
  factId?: string;
  episodes?: Array<{ episodeId?: string; text?: string }>;
}
interface PredicatesOut {
  predicates?: PredicateLike[];
}
interface WhyOut {
  symbol?: string;
  found?: number;
  memory?: Array<{ kind?: string; text?: string; status?: string }>;
}

const asWhyLike = (out: WhyOut): WhyLike => ({
  found: out.found ?? 0,
  memory: (out.memory ?? []).map((m) => ({ kind: m.kind ?? '', text: m.text ?? '' })),
});

// ── phase 0: builtin-predicate read (NO install — builtin by design) ─

async function readTenantPredicates(cfg: Config): Promise<PredicateLike[]> {
  const res = await restRaw<PredicatesOut>(cfg, 'GET', '/v1/admin/predicates');
  if (res.status === 401 || res.status === 403) {
    console.error(
      `code-memory: GET /v1/admin/predicates -> HTTP ${res.status} — the key lacks ` +
        'brain:admin. Phase 0 asserts the builtin seeding and cannot be skipped.',
    );
    process.exit(1);
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(`code-memory: GET /v1/admin/predicates -> HTTP ${res.status}.`);
    process.exit(1);
  }
  return res.json?.predicates ?? [];
}

// ── phase 1: write the corpus ───────────────────────────────────────

async function ingestTurns(cfg: Config, brain: HttpBrainClient): Promise<void> {
  // Run-scoped corpus: the dual-phrasing module's name carries the run
  // id, so k10 measures THIS run's path/symbol resolution instead of
  // re-attaching facts to twins an earlier run minted (entities are
  // tenant-global; only facts are per-user).
  const turns = buildTurns(cfg.runId);
  console.error(`[ingest] ${turns.length} mention turns (run ${cfg.runId})…`);
  for (const [i, turn] of turns.entries()) {
    // Deliberately NO knownEntities hints: the cross-entity check (k10)
    // measures whether the path and the symbol phrasing resolve to one
    // entity WITHOUT being told — hints would rig the measurement.
    await withRetry(`mention ${turn.conversation}#${turn.turn}`, () =>
      brain.ingest.mention({
        text: turn.text,
        contextRef: {
          vertical: CORPUS_VERTICAL,
          conversationId: convId(cfg, turn.conversation),
          messageId: messageId(cfg, turn.conversation, turn.turn),
          recorder: 'code-memory-battery',
        },
        knownEntities: [],
        userId: cfg.userId,
        emittedAt: turn.emittedAt,
      }),
    );
    if ((i + 1) % 10 === 0) console.error(`[ingest] ${i + 1}/${turns.length}`);
  }
}

// ── phase 2: execute the checks ─────────────────────────────────────

interface CheckContext {
  cfg: Config;
  mcp: McpClient;
  tools: Set<string>;
  tenantPredicates: PredicateLike[];
}

type Verdict2 = Pick<CheckResult, 'status' | 'detail'> & { answer?: string | null };

async function searchHits(ctx: CheckContext, query: string, limit: number): Promise<SearchHit[]> {
  const out = await callTool<SearchOut>(ctx.mcp, 'search_knowledge', {
    query,
    limit,
    userId: ctx.cfg.userId,
  });
  return out.results ?? [];
}

function runBuiltinVocabCheck(ctx: CheckContext, check: BuiltinVocabCheck): Verdict2 {
  const verdict = checkBuiltinPredicates(ctx.tenantPredicates, check.requiredPredicates);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runVocabCheck(ctx: CheckContext, check: PackVocabCheck): Promise<Verdict2> {
  const hits = await searchHits(ctx, check.searchQuery, 8);
  if (hits.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate entities' };
  }
  const verdict = findExactPredicateFact(hits as HitLike[], check.predicate, check.valueMarkers);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runLiteralHarvestCheck(
  ctx: CheckContext,
  check: LiteralHarvestCheck,
): Promise<Verdict2> {
  const parts: string[] = [];
  let allPass = true;
  for (const want of check.wants) {
    const hits = await searchHits(ctx, want.searchQuery, 8);
    const verdict = findExactPredicateFact(hits as HitLike[], want.predicate, want.valueMarkers);
    if (!verdict.pass) allPass = false;
    parts.push(`${want.predicate}: ${verdict.pass ? 'found' : verdict.detail}`);
  }
  return { status: allPass ? 'pass' : 'fail', detail: parts.join(' | ') };
}

async function runFlagTransitionCheck(
  ctx: CheckContext,
  check: FlagTransitionCheck,
): Promise<Verdict2> {
  const hits = await searchHits(ctx, check.searchQuery, HISTORY_ENTITY_CAP);
  if (hits.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate entities' };
  }
  // The two stages may live on the flag entity, the agent entity (the
  // state-verb lane binds transitions to the state HOLDER) or another
  // extraction-chosen subject — walk each candidate's timeline and
  // pass on the first retaining every stage in order; keep the deepest
  // partial as the fail detail.
  let best: { matchedStages: number; detail: string } | null = null;
  for (const hit of hits.slice(0, HISTORY_ENTITY_CAP)) {
    const timeline = await callTool<TimelineOut>(ctx.mcp, 'get_entity_timeline', {
      entityId: hit.entityId,
      userId: ctx.cfg.userId,
    });
    const events: HistoryEvent[] = (timeline.events ?? [])
      .filter((e) => e.type === 'fact.recorded')
      .map((e) => ({ predicate: e.predicate ?? '', object: e.object ?? '', at: e.at }));
    const verdict = checkHistorySequence(events, check.stages);
    if (verdict.pass) {
      return {
        status: 'pass',
        detail: `entity ${hit.canonicalName ?? hit.entityId}: ${verdict.detail}`,
      };
    }
    if (best === null || verdict.matchedStages > best.matchedStages) {
      best = {
        matchedStages: verdict.matchedStages,
        detail: `entity ${hit.canonicalName ?? hit.entityId}: ${verdict.detail}`,
      };
    }
  }
  return {
    status: 'fail',
    detail: `no entity timeline retains the full flag story; deepest: ${best?.detail ?? '(none)'}`,
  };
}

async function runSupersessionCheck(
  ctx: CheckContext,
  check: SupersessionCheck,
): Promise<Verdict2> {
  if (!ctx.tools.has('record_decision')) {
    return { status: 'skipped', detail: 'record_decision absent (key lacks brain:write?)' };
  }
  const symbol = saltedAnchor(ctx.cfg, check.anchor);
  await callTool(ctx.mcp, 'record_decision', {
    symbol,
    kind: 'decided',
    text: check.oldText,
  });
  await sleep(SUPERSESSION_GAP_MS);
  const cursor = new Date().toISOString();
  await sleep(SUPERSESSION_GAP_MS);
  await callTool(ctx.mcp, 'record_decision', {
    symbol,
    kind: 'decided',
    text: check.newText,
  });
  const now = asWhyLike(await callTool<WhyOut>(ctx.mcp, 'why', { symbol }));
  const atAsOf = asWhyLike(await callTool<WhyOut>(ctx.mcp, 'why', { symbol, asOf: cursor }));
  const verdict = checkSupersession(now, atAsOf, 'decided', check.oldMarkers, check.newMarkers);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runCrossEntityCheck(ctx: CheckContext, check: CrossEntityCheck): Promise<Verdict2> {
  const hits = await searchHits(ctx, check.searchQuery, 10);
  const resolution = resolveModuleEntity(hits as HitLike[], check.nameTokens);
  if (!resolution.ok) {
    return { status: 'fail', detail: resolution.fail.detail };
  }
  const entity = resolution.entity;
  // k10 measures IDENTITY — both phrasings' facts attached to the ONE
  // resolved entity. A search hit carries only query-ranked TOP facts,
  // which under-samples: a fact extraction split off the invariant
  // sentence (e.g. slotted as default_value) is attached to the module
  // yet can rank below the hit's fact cap for the module-name query
  // (measured: run cmmtq1z412 reported [cents|line-item]=0 while the
  // fact sat on the entity). So the marker scan runs over ALL facts
  // ever recorded onto the entity (get_entity_timeline — the full
  // chronological audit), unioned with the hit's facts. Slot quality
  // is k02–k06's scope, never re-punished here.
  const timeline = await callTool<TimelineOut>(ctx.mcp, 'get_entity_timeline', {
    entityId: entity.entityId,
    userId: ctx.cfg.userId,
  });
  const recorded: FactText[] = (timeline.events ?? [])
    .filter((e) => e.type === 'fact.recorded')
    .map((e) => ({ predicate: e.predicate ?? '', object: e.object ?? '' }));
  const seen = new Set<string>();
  const allFacts: FactText[] = [];
  for (const fact of [...recorded, ...(entity.facts ?? [])]) {
    const key = `${fact.predicate} ${fact.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allFacts.push({ predicate: fact.predicate, object: fact.object });
  }
  const verdict = checkEntityFactGroups(
    entity.canonicalName ?? entity.entityId,
    allFacts,
    check.mustCarryGroups,
  );
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runTraceProvenanceCheck(
  ctx: CheckContext,
  check: TraceProvenanceCheck,
): Promise<Verdict2> {
  if (!ctx.tools.has('get_fact_provenance')) {
    return { status: 'skipped', detail: 'get_fact_provenance absent (FACTS_API_ENABLED off)' };
  }
  const hits = await searchHits(ctx, check.searchQuery, 8);
  const factIdsPerHit: string[][] = hits.map((hit) => {
    const ids: string[] = [];
    for (const fact of hit.facts ?? []) {
      if (check.objectHint.length > 0) {
        const text = `${fact.predicate} ${fact.object}`.toLowerCase();
        if (!check.objectHint.some((h) => text.includes(h.toLowerCase()))) continue;
      }
      ids.push(fact.factId);
    }
    return ids;
  });
  // Round-robin across hits so one fat entity cannot monopolise the
  // walk budget — sibling interleave.ts.
  const candidates = interleaveRoundRobin(factIdsPerHit, PROVENANCE_CANDIDATE_CAP);
  if (candidates.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate facts' };
  }
  for (const factId of candidates) {
    const prov = await callTool<ProvenanceOut>(ctx.mcp, 'get_fact_provenance', { factId });
    const match = walkProvenance(prov, check.episodeFragments);
    if (match !== null) {
      return {
        status: 'pass',
        detail: `fact ${factId} unrolls to episode ${match.episodeId} ("${match.fragment}")`,
      };
    }
  }
  return {
    status: 'fail',
    detail: `${candidates.length} facts walked, no episode quotes the seeded fragment`,
  };
}

async function runServeCheck(ctx: CheckContext, check: ServeCheck): Promise<Verdict2> {
  const out = await callTool<SynthOut>(ctx.mcp, 'synthesize', {
    query: check.query,
    limit: 15,
    synthesisGuardrails: ctx.cfg.guardrails,
    userId: ctx.cfg.userId,
  });
  const verdict = scoreServe(out.answer, out.reason, {
    expectAnyOf: check.expectAnyOf,
    forbidAnyOf: check.forbidAnyOf,
  });
  return { status: verdict.status, detail: verdict.detail, answer: out.answer };
}

async function runIntentionGuardCheck(
  ctx: CheckContext,
  check: IntentionGuardCheck,
): Promise<Verdict2> {
  const hits = await searchHits(ctx, check.searchQuery, 10);
  const verdict = checkNoForbiddenFact(
    hits as HitLike[],
    check.forbidPredicate,
    check.forbidObjectMarkers,
  );
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runMcpRoundtripCheck(
  ctx: CheckContext,
  check: McpRoundtripCheck,
): Promise<Verdict2> {
  if (!ctx.tools.has('record_decision')) {
    return { status: 'skipped', detail: 'record_decision absent (key lacks brain:write?)' };
  }
  const symbol = saltedAnchor(ctx.cfg, check.anchor);
  await callTool(ctx.mcp, 'record_decision', {
    symbol,
    kind: check.recordKind,
    text: check.text,
  });
  const out = asWhyLike(await callTool<WhyOut>(ctx.mcp, 'why', { symbol }));
  const verdict = checkWhyRoundtrip(out, check.recordKind, check.textMarkers);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

function runNoRogueToolsCheck(ctx: CheckContext): Verdict2 {
  const offenders = findNamespacedTools([...ctx.tools]);
  if (offenders.length === 0) {
    return {
      status: 'pass',
      detail: `tools/list clean: 0 __-namespaced tools among ${ctx.tools.size}`,
    };
  }
  return {
    status: 'fail',
    detail: `unexpected pack-namespaced tool(s) exposed: ${offenders.join(', ')}`,
  };
}

async function runCheck(ctx: CheckContext, check: Check): Promise<Verdict2> {
  switch (check.kind) {
    case 'builtin-vocab':
      return runBuiltinVocabCheck(ctx, check);
    case 'pack-vocab':
      return runVocabCheck(ctx, check);
    case 'literal-harvest':
      return runLiteralHarvestCheck(ctx, check);
    case 'flag-transition':
      return runFlagTransitionCheck(ctx, check);
    case 'supersession-asof':
      return runSupersessionCheck(ctx, check);
    case 'cross-entity':
      return runCrossEntityCheck(ctx, check);
    case 'trace-provenance':
      return runTraceProvenanceCheck(ctx, check);
    case 'serve':
      return runServeCheck(ctx, check);
    case 'intention-guard':
      return runIntentionGuardCheck(ctx, check);
    case 'mcp-roundtrip':
      return runMcpRoundtripCheck(ctx, check);
    case 'no-rogue-tools':
      return runNoRogueToolsCheck(ctx);
  }
}

async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of buildChecks(ctx.cfg.runId)) {
    const started = Date.now();
    let verdict: Verdict2;
    try {
      verdict = await runCheck(ctx, check);
    } catch (err) {
      verdict = { status: 'fail', detail: `runner error: ${String(err)}` };
    }
    const latencyMs = Date.now() - started;
    const result: CheckResult = {
      id: check.id,
      kind: check.kind,
      cls: check.cls,
      status: verdict.status,
      detail: verdict.detail,
      latencyMs,
      ...(verdict.answer !== undefined ? { answer: verdict.answer } : {}),
      ...(check.expectedUnknown !== undefined ? { expectedUnknown: check.expectedUnknown } : {}),
    };
    results.push(result);
    const note =
      verdict.status === 'fail' && check.expectedUnknown !== undefined
        ? ' (gap-gated finding)'
        : '';
    console.error(
      `[check] ${check.id} (${check.kind}) ${verdict.status}${note} ` +
        `${latencyMs}ms — ${verdict.detail}`,
    );
  }
  return results;
}

// ── scorecard ───────────────────────────────────────────────────────

const emptyTally = (): Tally => ({ pass: 0, fail: 0, skipped: 0 });

function buildScorecard(
  cfg: Config,
  startedAt: string,
  setup: Record<string, string>,
  results: CheckResult[],
): Scorecard {
  const classes: Record<string, Tally> = {};
  const checkKinds: Record<CheckKind, Tally> = {
    'builtin-vocab': emptyTally(),
    'pack-vocab': emptyTally(),
    'literal-harvest': emptyTally(),
    'flag-transition': emptyTally(),
    'supersession-asof': emptyTally(),
    'cross-entity': emptyTally(),
    'trace-provenance': emptyTally(),
    serve: emptyTally(),
    'intention-guard': emptyTally(),
    'mcp-roundtrip': emptyTally(),
    'no-rogue-tools': emptyTally(),
  };
  const checks = { pass: 0, fail: 0, skipped: 0, total: 0, failedExpectedUnknown: 0 };
  for (const r of results) {
    const cls = (classes[r.cls] ??= emptyTally());
    cls[r.status] += 1;
    checkKinds[r.kind][r.status] += 1;
    checks[r.status] += 1;
    checks.total += 1;
    if (r.status === 'fail' && r.expectedUnknown !== undefined) {
      checks.failedExpectedUnknown += 1;
    }
  }
  return {
    runId: cfg.runId,
    baseUrl: cfg.baseUrl,
    companyId: cfg.companyId,
    userId: cfg.userId,
    guardrails: cfg.guardrails,
    startedAt,
    finishedAt: new Date().toISOString(),
    setup,
    ingest: { mentionTurns: cfg.skipIngest ? 0 : buildTurns(cfg.runId).length },
    classes,
    checkKinds,
    checks,
    gapGatedChecks: buildChecks(cfg.runId)
      .filter((c) => c.expectedUnknown !== undefined)
      .map((c) => c.id),
    results,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(`code-memory scorecard — run ${card.runId} (guardrails=${card.guardrails})`);
  console.log('─'.repeat(72));
  for (const [cls, tally] of Object.entries(card.classes)) {
    console.log(
      `${cls.padEnd(22)} checks: pass ${tally.pass}  fail ${tally.fail}` +
        (tally.skipped > 0 ? `  skipped ${tally.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  const scored = card.checks.pass + card.checks.fail;
  const pct = scored === 0 ? 0 : Math.round((card.checks.pass / scored) * 1000) / 10;
  console.log(
    `checks: ${card.checks.pass}/${scored} scored (${pct}%), ` +
      `${card.checks.skipped} skipped of ${card.checks.total}` +
      (card.checks.failedExpectedUnknown > 0
        ? ` — ${card.checks.failedExpectedUnknown} fail(s) are gap-gated findings, not regressions`
        : ''),
  );
  console.log(
    `gap-gated (expectedUnknown): ${card.gapGatedChecks.join(', ')} — a fail there is ` +
      'the recorded gap; a pass is the measured signal the parallel PR landed.',
  );
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(`code-memory: run ${cfg.runId} against ${cfg.baseUrl} (tenant ${cfg.companyId})`);

  // Phase 0: read the tenant predicate registry. NO pack install — the
  // pack is builtin (seeded at bootstrap; install rejects the id), and
  // k01 scores the seeding itself.
  const tenantPredicates = await readTenantPredicates(cfg);
  const present = Object.values(CM).filter((id) =>
    tenantPredicates.some((p) => p.predicateId === id),
  ).length;
  const setup: Record<string, string> = {
    code_memory:
      `builtin — no install performed (install rejects builtin ids by design); ` +
      `${present}/${Object.values(CM).length} namespaced predicates visible in ` +
      `${tenantPredicates.length} registry rows`,
  };
  console.error(`[setup] ${setup['code_memory']}`);

  const brain = new HttpBrainClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const mcp = await connectMcp(cfg);
  try {
    const toolList = await withRetry('tools/list', () => mcp.listTools());
    const tools = new Set(toolList.tools.map((t) => t.name));
    console.error(`[mcp] connected, ${tools.size} tools visible`);

    if (!cfg.skipIngest) {
      await ingestTurns(cfg, brain);
    }

    const results = await runChecks({ cfg, mcp, tools, tenantPredicates });
    const card = buildScorecard(cfg, startedAt, setup, results);

    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `code-memory-${cfg.runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
    printScorecard(card);
    console.log(`report: ${reportPath}`);
  } finally {
    await mcp.close();
  }
}

void main().catch((err: unknown) => {
  console.error('code-memory: runner failed:', err);
  process.exitCode = 1;
});
