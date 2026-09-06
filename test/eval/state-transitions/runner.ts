/**
 * State-transition runner — drives EVERYTHING through the real wire,
 * mirroring the memory-fitness sibling:
 *
 *  - REST  POST /v1/ingest/mention            (scenario turns, per-user scoped)
 *  - REST  POST /v1/admin/maintenance/scenes | scenes/backlink | scenes/beliefs
 *          (best-effort admin builds; 404 = flag off = the dependent
 *          check is skipped, never silently passed)
 *  - MCP   synthesize / search_knowledge / get_entity_timeline /
 *          get_fact_provenance
 *  - REST  GET /v1/beliefs                    (belief read API)
 *
 * Scoring is fully mechanical (see scorers.ts) — no LLM judge. The
 * serving calls cost normal model spend on the stand; the battery
 * itself spends nothing on judging.
 *
 * Run: pnpm eval:state-transitions   (see README.md for stand flags)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HttpBrainClient } from '../http-brain-client';
import { interleaveRoundRobin } from '../memory-fitness/interleave';
import { walkProvenance } from '../memory-fitness/scorers';
import { ALL_TURNS, BORIS_REF, CORPUS_VERTICAL, SCENARIOS, SPEAKER } from './scenarios';
import { checkBelief, checkHistorySequence, scoreServe, type HistoryEvent } from './scorers';
import type {
  BeliefCheck,
  Check,
  CheckKind,
  CheckResult,
  CheckStatus,
  FactHistoryCheck,
  ProvenanceCheck,
  Scenario,
  ScenarioResult,
  Scorecard,
  ServeCheck,
  Tally,
} from './types';

/**
 * Provenance-walk budget: how many candidate facts get their provenance
 * unrolled per check. Candidates are interleaved round-robin across
 * search hits (the sibling's interleave.ts) before this cap.
 */
const PROVENANCE_CANDIDATE_CAP = 12;

/** How many search hits get their timeline walked per fact-history check. */
const HISTORY_ENTITY_CAP = 6;

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
        'state-transitions: BRAIN_BASE_URL is not set — nothing to run against.',
        'This battery drives a LIVE brain stand over MCP + REST (it needs a booted',
        'service and its OpenAI key) and is intentionally never run in CI.',
        '',
        'Required env:',
        '  BRAIN_BASE_URL   e.g. http://localhost:3000  (BRAIN_URL also accepted)',
        '  BRAIN_API_KEY    tenant M2M key with brain:read + brain:write',
        '                   (+ brain:admin for the optional scene/belief builds)',
        '  BRAIN_COMPANY_ID tenant id — use a FRESH tenant per run (see README.md)',
        '',
        'Optional env: STEV_USER_ID, STEV_RUN_ID, STEV_GUARDRAILS',
        '(strict|lenient|off, default strict), STEV_SKIP_INGEST=1 (re-ask an',
        'already-ingested run — requires the same STEV_RUN_ID), STEV_REPORT_DIR.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (apiKey === undefined || apiKey === '') {
    console.error('state-transitions: BRAIN_API_KEY is not set.');
    process.exit(1);
  }
  if (companyId === undefined || companyId === '') {
    console.error('state-transitions: BRAIN_COMPANY_ID is not set.');
    process.exit(1);
  }
  const guardrailsRaw = process.env.STEV_GUARDRAILS ?? 'strict';
  if (guardrailsRaw !== 'strict' && guardrailsRaw !== 'lenient' && guardrailsRaw !== 'off') {
    console.error('state-transitions: STEV_GUARDRAILS must be strict|lenient|off.');
    process.exit(1);
  }
  // Run-scoped default user (the #456 hermeticity doctrine): a FIXED
  // default userId accumulates state across runs on one tenant, and the
  // leftovers poison later measurements two ways — stale ACTIVE twins
  // out-shout freshly formed competing pairs at serve time, and
  // entity-upsert's exact match re-attaches new facts to pre-fix twins
  // forever. Salting the default with the runId makes every run
  // hermetic by construction; a same-memory re-ask still works because
  // STEV_SKIP_INGEST already requires pinning STEV_RUN_ID (same salt ⇒
  // same user). An explicit STEV_USER_ID keeps full control.
  const runId = process.env.STEV_RUN_ID ?? `st${Date.now().toString(36)}`;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    companyId,
    userId: process.env.STEV_USER_ID ?? `stev-agent-${runId}`,
    runId,
    guardrails: guardrailsRaw,
    skipIngest: process.env.STEV_SKIP_INGEST === '1',
    reportDir: process.env.STEV_REPORT_DIR ?? join('var', 'state-transitions'),
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

// ── REST (raw, non-throwing — admin builds and belief reads need the status) ──

interface RestResult<T> {
  status: number;
  json: T | null;
}

async function restRaw<T>(
  cfg: Config,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<RestResult<T>> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  const client = new McpClient({ name: 'state-transitions-battery', version: '1.0.0' });
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
interface BeliefsOut {
  beliefs?: Array<{
    subject: string;
    field: string;
    value: string;
    priorValue?: string;
    revision?: number;
  }>;
}

// ── phase 1: write the world-state ──────────────────────────────────

async function ingestTurns(cfg: Config, brain: HttpBrainClient): Promise<void> {
  console.error(`[ingest] ${ALL_TURNS.length} mention turns (run ${cfg.runId})…`);
  for (const [i, turn] of ALL_TURNS.entries()) {
    const knownEntities: Array<Record<string, string>> = [{ ...SPEAKER }];
    if (turn.text.includes('Boris')) {
      knownEntities.push({ ...BORIS_REF, name: 'Boris' });
    }
    await withRetry(`mention ${turn.conversation}#${turn.turn}`, () =>
      brain.ingest.mention({
        text: turn.text,
        contextRef: {
          vertical: CORPUS_VERTICAL,
          conversationId: convId(cfg, turn.conversation),
          messageId: messageId(cfg, turn.conversation, turn.turn),
          recorder: 'state-transitions-battery',
        },
        knownEntities,
        userId: cfg.userId,
        emittedAt: turn.emittedAt,
      }),
    );
    if ((i + 1) % 10 === 0) console.error(`[ingest] ${i + 1}/${ALL_TURNS.length}`);
  }
}

async function runBuilds(cfg: Config): Promise<Record<string, string>> {
  // scenes -> (enrich happens in-build when SCENES_LLM_ENRICHMENT is on)
  // -> backlink -> beliefs. Every step is best-effort: a 404 means the
  // stand runs without that flag and the dependent check is SKIPPED.
  const builds: Record<string, string> = {};
  for (const step of ['scenes', 'scenes/backlink', 'scenes/beliefs']) {
    const res = await restRaw<Record<string, unknown>>(
      cfg,
      'POST',
      `/v1/admin/maintenance/${step}`,
      {},
    );
    builds[step] =
      res.status === 404
        ? 'skipped: 404 (scene flag off)'
        : res.status === 403
          ? 'skipped: 403 (key lacks brain:admin)'
          : res.status >= 200 && res.status < 300
            ? 'ok'
            : `error: HTTP ${res.status}`;
    console.error(`[build] ${step}: ${builds[step]}`);
  }
  return builds;
}

// ── phase 2: execute the checks ─────────────────────────────────────

interface CheckContext {
  cfg: Config;
  mcp: McpClient;
  tools: Set<string>;
  builds: Record<string, string>;
}

type Verdict = Pick<CheckResult, 'status' | 'detail'> & { answer?: string | null };

async function searchHits(ctx: CheckContext, query: string, limit: number): Promise<SearchHit[]> {
  const out = await callTool<SearchOut>(ctx.mcp, 'search_knowledge', {
    query,
    limit,
    userId: ctx.cfg.userId,
  });
  return out.results ?? [];
}

async function runServeCheck(ctx: CheckContext, check: ServeCheck): Promise<Verdict> {
  const out = await callTool<SynthOut>(ctx.mcp, 'synthesize', {
    query: check.query,
    limit: 15,
    synthesisGuardrails: ctx.cfg.guardrails,
    userId: ctx.cfg.userId,
  });
  const verdict = scoreServe(out.answer, out.reason, check);
  return { status: verdict.status, detail: verdict.detail, answer: out.answer };
}

async function runBeliefCheck(ctx: CheckContext, check: BeliefCheck): Promise<Verdict> {
  if (ctx.builds['scenes/beliefs'] !== 'ok') {
    return {
      status: 'skipped',
      detail: `belief build not run (${ctx.builds['scenes/beliefs'] ?? 'no build phase'})`,
    };
  }
  const res = await restRaw<BeliefsOut>(
    ctx.cfg,
    'GET',
    `/v1/beliefs?userId=${encodeURIComponent(ctx.cfg.userId)}&limit=100`,
  );
  if (res.status === 404) {
    return { status: 'skipped', detail: 'BELIEFS_API_ENABLED off (404)' };
  }
  const verdict = checkBelief(res.json?.beliefs ?? [], check);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runHistoryCheck(ctx: CheckContext, check: FactHistoryCheck): Promise<Verdict> {
  const hits = await searchHits(ctx, check.searchQuery, HISTORY_ENTITY_CAP);
  if (hits.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate entities' };
  }
  // The transition may live on any of several extracted entities (the
  // object, the speaker, …) — walk each candidate's timeline and pass
  // on the first one whose fact.recorded events retain every stage in
  // order; keep the deepest partial match as the fail detail.
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
    detail: `no entity timeline retains the full sequence; deepest: ${best?.detail ?? '(none)'}`,
  };
}

async function runProvenanceCheck(ctx: CheckContext, check: ProvenanceCheck): Promise<Verdict> {
  if (!ctx.tools.has('get_fact_provenance')) {
    return { status: 'skipped', detail: 'get_fact_provenance absent (FACTS_API_ENABLED off)' };
  }
  const hits = await searchHits(ctx, check.searchQuery, 8);
  const factIdsPerHit: string[][] = hits.map((hit) => {
    const ids: string[] = [];
    for (const fact of hit.facts ?? []) {
      if (check.predicateHint !== undefined && check.predicateHint !== '') {
        if (!fact.predicate.includes(check.predicateHint)) continue;
      }
      ids.push(fact.factId);
    }
    return ids;
  });
  // Round-robin across hits (hit1.fact1, hit2.fact1, …) so one fat
  // entity cannot monopolise the walk budget — sibling interleave.ts.
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
    detail: `${candidates.length} facts walked, no episode quotes a seeded fragment`,
  };
}

async function runCheck(ctx: CheckContext, check: Check): Promise<Verdict> {
  switch (check.kind) {
    case 'serve':
      return runServeCheck(ctx, check);
    case 'belief':
      return runBeliefCheck(ctx, check);
    case 'fact-history':
      return runHistoryCheck(ctx, check);
    case 'provenance':
      return runProvenanceCheck(ctx, check);
  }
}

async function runScenario(ctx: CheckContext, scenario: Scenario): Promise<ScenarioResult> {
  const results: CheckResult[] = [];
  for (const check of scenario.checks) {
    const started = Date.now();
    let verdict: Verdict;
    try {
      verdict = await runCheck(ctx, check);
    } catch (err) {
      verdict = { status: 'fail', detail: `runner error: ${String(err)}` };
    }
    const latencyMs = Date.now() - started;
    const result: CheckResult = {
      id: check.id,
      kind: check.kind,
      status: verdict.status,
      detail: verdict.detail,
      latencyMs,
      ...(verdict.answer !== undefined ? { answer: verdict.answer } : {}),
      ...(check.knownFailToday !== undefined ? { knownFailToday: check.knownFailToday } : {}),
    };
    results.push(result);
    const expectedNote =
      verdict.status === 'fail' && check.knownFailToday !== undefined ? ' (expected today)' : '';
    console.error(
      `[check] ${check.id} (${check.kind}) ${verdict.status}${expectedNote} ` +
        `${latencyMs}ms — ${verdict.detail}`,
    );
  }
  const anyFail = results.some((r) => r.status === 'fail');
  const anySkipped = results.some((r) => r.status === 'skipped');
  const status: CheckStatus = anyFail ? 'fail' : anySkipped ? 'skipped' : 'pass';
  return { key: scenario.key, name: scenario.name, cls: scenario.cls, status, checks: results };
}

// ── scorecard ───────────────────────────────────────────────────────

const emptyTally = (): Tally => ({ pass: 0, fail: 0, skipped: 0 });

function buildScorecard(
  cfg: Config,
  startedAt: string,
  builds: Record<string, string>,
  results: ScenarioResult[],
): Scorecard {
  const classes: Record<string, Tally> = {};
  const checkKinds: Record<CheckKind, Tally> = {
    serve: emptyTally(),
    belief: emptyTally(),
    'fact-history': emptyTally(),
    provenance: emptyTally(),
  };
  const scenarios = { pass: 0, fail: 0, skipped: 0, total: results.length };
  const checks = { pass: 0, fail: 0, skipped: 0, total: 0, failedExpectedToday: 0 };
  for (const r of results) {
    const cls = (classes[r.cls] ??= emptyTally());
    cls[r.status] += 1;
    scenarios[r.status] += 1;
    for (const c of r.checks) {
      checkKinds[c.kind][c.status] += 1;
      checks[c.status] += 1;
      checks.total += 1;
      if (c.status === 'fail' && c.knownFailToday !== undefined) {
        checks.failedExpectedToday += 1;
      }
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
    ingest: { mentionTurns: cfg.skipIngest ? 0 : ALL_TURNS.length, builds },
    classes,
    checkKinds,
    scenarios,
    checks,
    results,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(`state-transitions scorecard — run ${card.runId} (guardrails=${card.guardrails})`);
  console.log('─'.repeat(72));
  for (const [cls, tally] of Object.entries(card.classes)) {
    console.log(
      `${cls.padEnd(22)} scenarios: pass ${tally.pass}  fail ${tally.fail}` +
        (tally.skipped > 0 ? `  skipped ${tally.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  for (const [kind, tally] of Object.entries(card.checkKinds)) {
    console.log(
      `${kind.padEnd(22)} checks:    pass ${tally.pass}  fail ${tally.fail}` +
        (tally.skipped > 0 ? `  skipped ${tally.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  const scoredScenarios = card.scenarios.pass + card.scenarios.fail;
  const scoredChecks = card.checks.pass + card.checks.fail;
  const pct = (pass: number, scored: number): number =>
    scored === 0 ? 0 : Math.round((pass / scored) * 1000) / 10;
  console.log(
    `scenarios: ${card.scenarios.pass}/${scoredScenarios} scored ` +
      `(${pct(card.scenarios.pass, scoredScenarios)}%), ` +
      `${card.scenarios.skipped} skipped of ${card.scenarios.total}`,
  );
  console.log(
    `checks:    ${card.checks.pass}/${scoredChecks} scored ` +
      `(${pct(card.checks.pass, scoredChecks)}%), ` +
      `${card.checks.skipped} skipped of ${card.checks.total}` +
      (card.checks.failedExpectedToday > 0
        ? ` — ${card.checks.failedExpectedToday} fail(s) expected on today's code (#135)`
        : ''),
  );
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(
    `state-transitions: run ${cfg.runId} against ${cfg.baseUrl} (tenant ${cfg.companyId})`,
  );

  const brain = new HttpBrainClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const mcp = await connectMcp(cfg);
  try {
    const toolList = await withRetry('tools/list', () => mcp.listTools());
    const tools = new Set(toolList.tools.map((t) => t.name));
    console.error(`[mcp] connected, ${tools.size} tools visible`);

    let builds: Record<string, string> = { scenes: 'skipped: STEV_SKIP_INGEST' };
    if (!cfg.skipIngest) {
      await ingestTurns(cfg, brain);
      builds = await runBuilds(cfg);
    }

    const ctx: CheckContext = { cfg, mcp, tools, builds };
    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      console.error(
        `[scenario] ${scenario.key} ${scenario.name} (${scenario.checks.length} checks)`,
      );
      results.push(await runScenario(ctx, scenario));
    }
    const card = buildScorecard(cfg, startedAt, builds, results);

    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `state-transitions-${cfg.runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
    printScorecard(card);
    console.log(`report: ${reportPath}`);
  } finally {
    await mcp.close();
  }
}

void main().catch((err: unknown) => {
  console.error('state-transitions: runner failed:', err);
  process.exitCode = 1;
});
