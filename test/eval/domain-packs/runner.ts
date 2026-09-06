/**
 * Domain-pack battery runner — drives EVERYTHING through the real
 * wire, mirroring the memory-fitness / state-transitions siblings:
 *
 *  - REST  GET/POST /v1/admin/packs[.../from-registry]
 *          (phase 0: install fintech + medical into the tenant; a
 *          missing registry entry is republished from the local
 *          manifest when the key can, else the runner FAILS with the
 *          registry:seed instructions — setup is never silently skipped)
 *  - REST  POST /v1/ingest/mention            (corpus turns, per-user scoped)
 *  - MCP   tools/list / synthesize / search_knowledge /
 *          get_entity_timeline / get_fact_provenance
 *
 * Scoring is fully mechanical (see scorers.ts) — no LLM judge. The
 * serving calls cost normal model spend on the stand; the battery
 * itself spends nothing on judging.
 *
 * Run: pnpm eval:domain-packs   (see README.md for stand flags)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { packChecksum } from '../../../src/ai/domain-packs/checksum';
import type { DomainPackManifest } from '../../../src/ai/domain-packs/manifest';
import { HttpBrainClient } from '../http-brain-client';
import { interleaveRoundRobin } from '../memory-fitness/interleave';
import { walkProvenance } from '../memory-fitness/scorers';
import { checkHistorySequence, scoreServe, type HistoryEvent } from '../state-transitions/scorers';
import {
  ALL_TURNS,
  CHECKS,
  CORPUS_VERTICAL,
  FINTECH_PACK,
  MEDICAL_PACK,
  MERIDIAN_NAME,
  MERIDIAN_REF,
  VEGA_NAME,
  VEGA_REF,
} from './corpus';
import {
  checkCrossDomainEntity,
  checkInterleavedDomains,
  checkPacksInstalled,
  findExactPredicateFact,
  findNamespacedTools,
  scoreServeCross,
  type HitLike,
  type InstalledPackLike,
} from './scorers';
import type {
  Check,
  CheckKind,
  CheckResult,
  CrossEntityCheck,
  InstallCheck,
  PackTransitionCheck,
  PackVocabCheck,
  Scorecard,
  ServeCrossCheck,
  ServeIsolationCheck,
  Tally,
  TraceInterleaveCheck,
  TraceProvenanceCheck,
} from './types';

/** Provenance-walk budget per check (sibling round-robin interleave). */
const PROVENANCE_CANDIDATE_CAP = 12;

/** How many search hits get their timeline walked per transition check. */
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
        'domain-packs: BRAIN_BASE_URL is not set — nothing to run against.',
        'This battery drives a LIVE brain stand over MCP + REST (it needs a booted',
        'service and its OpenAI key) and is intentionally never run in CI.',
        '',
        'Required env:',
        '  BRAIN_BASE_URL   e.g. http://localhost:3000  (BRAIN_URL also accepted)',
        '  BRAIN_API_KEY    tenant M2M key with brain:read + brain:write + brain:admin',
        '                   (phase 0 installs the packs through /v1/admin/packs)',
        '  BRAIN_COMPANY_ID tenant id — use a FRESH tenant per run (see README.md)',
        '',
        'Prerequisite: the GLOBAL pack registry must hold fintech + medical',
        '(one-time: BRAIN_API_KEY=<registry:publish key> pnpm registry:seed -- \\',
        '  --brain-url <url>). The runner republishes from the local manifests',
        'when its key can; otherwise it fails with this instruction.',
        '',
        'Optional env: DPEV_USER_ID, DPEV_RUN_ID, DPEV_GUARDRAILS',
        '(strict|lenient|off, default strict), DPEV_SKIP_INGEST=1 (re-ask an',
        'already-ingested run — requires the same DPEV_RUN_ID), DPEV_REPORT_DIR.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (apiKey === undefined || apiKey === '') {
    console.error('domain-packs: BRAIN_API_KEY is not set.');
    process.exit(1);
  }
  if (companyId === undefined || companyId === '') {
    console.error('domain-packs: BRAIN_COMPANY_ID is not set.');
    process.exit(1);
  }
  const guardrailsRaw = process.env.DPEV_GUARDRAILS ?? 'strict';
  if (guardrailsRaw !== 'strict' && guardrailsRaw !== 'lenient' && guardrailsRaw !== 'off') {
    console.error('domain-packs: DPEV_GUARDRAILS must be strict|lenient|off.');
    process.exit(1);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    companyId,
    userId: process.env.DPEV_USER_ID ?? 'dp-agent',
    runId: process.env.DPEV_RUN_ID ?? `dp${Date.now().toString(36)}`,
    guardrails: guardrailsRaw,
    skipIngest: process.env.DPEV_SKIP_INGEST === '1',
    reportDir: process.env.DPEV_REPORT_DIR ?? join('var', 'domain-packs'),
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

// ── REST (raw, non-throwing — the setup phase branches on the status) ──

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
  const client = new McpClient({ name: 'domain-packs-battery', version: '1.0.0' });
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
interface PacksListOut {
  installed?: Array<InstalledPackLike & { predicateCount?: number }>;
}
interface InstallOut {
  packId?: string;
  version?: string;
  predicatesSeeded?: number;
}

// ── phase 0: pack setup (idempotent) ────────────────────────────────

const seedInstruction = (cfg: Config): string =>
  [
    'The GLOBAL pack registry does not hold the pack and this key cannot',
    'publish it. Seed the registry once with a registry:publish key:',
    `  BRAIN_API_KEY=<registry:publish key> pnpm registry:seed -- --brain-url ${cfg.baseUrl}`,
    'then re-run pnpm eval:domain-packs.',
  ].join('\n');

async function installOnePack(cfg: Config, pack: DomainPackManifest): Promise<string> {
  const fromRegistry = (): Promise<RestResult<InstallOut>> =>
    restRaw<InstallOut>(cfg, 'POST', '/v1/admin/packs/from-registry', {
      packId: pack.id,
      version: pack.version,
    });
  let res = await fromRegistry();
  let republished = false;
  if (res.status < 200 || res.status >= 300) {
    // Registry likely empty (fresh stand: zero installs anywhere). Try to
    // publish the LOCAL manifest through the registry admin route — the
    // seed script's logic over REST, checksum-pinned.
    const pub = await restRaw<Record<string, unknown>>(cfg, 'POST', '/v1/admin/registry/packs', {
      manifest: pack,
      expectedChecksum: packChecksum(pack),
    });
    if (pub.status >= 200 && pub.status < 300) {
      republished = true;
      res = await fromRegistry();
    } else {
      console.error(
        `domain-packs: install of ${pack.id}@${pack.version} failed ` +
          `(from-registry HTTP ${res.status}; registry publish HTTP ${pub.status}).`,
      );
      console.error(seedInstruction(cfg));
      process.exit(1);
    }
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(
      `domain-packs: install of ${pack.id}@${pack.version} still failed after ` +
        `registry publish (HTTP ${res.status}). Fix the stand before running.`,
    );
    process.exit(1);
  }
  return (
    `installed v${res.json?.version ?? pack.version} ` +
    `(predicatesSeeded=${res.json?.predicatesSeeded ?? '?'}` +
    `${republished ? ', registry-published from local manifest' : ''})`
  );
}

async function ensurePackSetup(cfg: Config): Promise<Record<string, string>> {
  const setup: Record<string, string> = {};
  const list = await restRaw<PacksListOut>(cfg, 'GET', '/v1/admin/packs');
  if (list.status === 401 || list.status === 403) {
    console.error(
      `domain-packs: GET /v1/admin/packs -> HTTP ${list.status} — the key lacks ` +
        'brain:admin. Phase 0 installs packs and cannot be skipped.',
    );
    process.exit(1);
  }
  if (list.status < 200 || list.status >= 300) {
    console.error(`domain-packs: GET /v1/admin/packs -> HTTP ${list.status}.`);
    process.exit(1);
  }
  const installed = list.json?.installed ?? [];
  for (const pack of [FINTECH_PACK, MEDICAL_PACK]) {
    const already = installed.find((p) => p.packId === pack.id);
    // Skip only on an exact version match: the install check (corpus
    // wantsPacksInstalled) pins the LOCAL manifest version, so a stand
    // holding an older install must be upgraded (install upsert = upgrade),
    // not skipped — otherwise every manifest bump strands the battery.
    if (already !== undefined && already.version === pack.version) {
      setup[pack.id] = `already installed v${already.version}`;
      console.error(`[setup] ${pack.id}: ${setup[pack.id]}`);
      continue;
    }
    setup[pack.id] = await installOnePack(cfg, pack);
    console.error(`[setup] ${pack.id}: ${setup[pack.id]}`);
  }
  return setup;
}

// ── phase 1: write the corpus ───────────────────────────────────────

async function ingestTurns(cfg: Config, brain: HttpBrainClient): Promise<void> {
  console.error(`[ingest] ${ALL_TURNS.length} mention turns (run ${cfg.runId})…`);
  for (const [i, turn] of ALL_TURNS.entries()) {
    const knownEntities: Array<Record<string, string>> = [];
    if (turn.text.includes('Meridian')) {
      knownEntities.push({ ...MERIDIAN_REF, name: MERIDIAN_NAME });
    }
    if (turn.text.includes('Vega')) {
      knownEntities.push({ ...VEGA_REF, name: VEGA_NAME });
    }
    await withRetry(`mention ${turn.conversation}#${turn.turn}`, () =>
      brain.ingest.mention({
        text: turn.text,
        contextRef: {
          vertical: CORPUS_VERTICAL,
          conversationId: convId(cfg, turn.conversation),
          messageId: messageId(cfg, turn.conversation, turn.turn),
          recorder: 'domain-packs-battery',
        },
        knownEntities,
        userId: cfg.userId,
        emittedAt: turn.emittedAt,
      }),
    );
    if ((i + 1) % 10 === 0) console.error(`[ingest] ${i + 1}/${ALL_TURNS.length}`);
  }
}

// ── phase 2: execute the checks ─────────────────────────────────────

interface CheckContext {
  cfg: Config;
  mcp: McpClient;
  tools: Set<string>;
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

async function runInstallCheck(ctx: CheckContext, check: InstallCheck): Promise<Verdict> {
  const res = await restRaw<PacksListOut>(ctx.cfg, 'GET', '/v1/admin/packs');
  if (res.status < 200 || res.status >= 300) {
    return { status: 'fail', detail: `GET /v1/admin/packs -> HTTP ${res.status}` };
  }
  const verdict = checkPacksInstalled(res.json?.installed ?? [], check.packs);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runVocabCheck(ctx: CheckContext, check: PackVocabCheck): Promise<Verdict> {
  const hits = await searchHits(ctx, check.searchQuery, 8);
  if (hits.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate entities' };
  }
  const verdict = findExactPredicateFact(hits as HitLike[], check.predicate, check.valueMarkers);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runTransitionCheck(ctx: CheckContext, check: PackTransitionCheck): Promise<Verdict> {
  const hits = await searchHits(ctx, check.searchQuery, HISTORY_ENTITY_CAP);
  if (hits.length === 0) {
    return { status: 'fail', detail: 'search returned no candidate entities' };
  }
  // The transition may live on any of several extracted entities (the
  // clinic, the course, …) — walk each candidate's timeline and pass on
  // the first one whose fact.recorded events retain every stage in
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

async function runCrossEntityCheck(ctx: CheckContext, check: CrossEntityCheck): Promise<Verdict> {
  const hits = await searchHits(ctx, check.searchQuery, 10);
  const verdict = checkCrossDomainEntity(hits as HitLike[], check);
  return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
}

async function runTraceProvenanceCheck(
  ctx: CheckContext,
  check: TraceProvenanceCheck,
): Promise<Verdict> {
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
    detail: `${candidates.length} facts walked, no episode quotes the domain's seeded fragment`,
  };
}

async function runTraceInterleaveCheck(
  ctx: CheckContext,
  check: TraceInterleaveCheck,
): Promise<Verdict> {
  const hits = await searchHits(ctx, check.searchQuery, 10);
  const target = hits.find((h) =>
    (h.canonicalName ?? '').toLowerCase().includes(check.entityNameToken.toLowerCase()),
  );
  if (target === undefined) {
    return {
      status: 'fail',
      detail: `no hit named ~"${check.entityNameToken}" among ${hits.length} results`,
    };
  }
  const timeline = await callTool<TimelineOut>(ctx.mcp, 'get_entity_timeline', {
    entityId: target.entityId,
    userId: ctx.cfg.userId,
  });
  const events: HistoryEvent[] = (timeline.events ?? [])
    .filter((e) => e.type === 'fact.recorded')
    .map((e) => ({ predicate: e.predicate ?? '', object: e.object ?? '', at: e.at }));
  const [a, b] = check.domains;
  const verdict = checkInterleavedDomains(events, a, b);
  return {
    status: verdict.pass ? 'pass' : 'fail',
    detail: `entity ${target.canonicalName ?? target.entityId}: ${verdict.detail}`,
  };
}

async function runServeCrossCheck(ctx: CheckContext, check: ServeCrossCheck): Promise<Verdict> {
  const out = await callTool<SynthOut>(ctx.mcp, 'synthesize', {
    query: check.query,
    limit: 15,
    synthesisGuardrails: ctx.cfg.guardrails,
    userId: ctx.cfg.userId,
  });
  const verdict = scoreServeCross(out.answer, out.reason, check.requireGroups);
  return { status: verdict.status, detail: verdict.detail, answer: out.answer };
}

async function runIsolationCheck(ctx: CheckContext, check: ServeIsolationCheck): Promise<Verdict> {
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

function runNoRogueToolsCheck(ctx: CheckContext): Verdict {
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

async function runCheck(ctx: CheckContext, check: Check): Promise<Verdict> {
  switch (check.kind) {
    case 'install':
      return runInstallCheck(ctx, check);
    case 'pack-vocab':
      return runVocabCheck(ctx, check);
    case 'pack-transition':
      return runTransitionCheck(ctx, check);
    case 'cross-entity':
      return runCrossEntityCheck(ctx, check);
    case 'trace-provenance':
      return runTraceProvenanceCheck(ctx, check);
    case 'trace-interleave':
      return runTraceInterleaveCheck(ctx, check);
    case 'serve-cross':
      return runServeCrossCheck(ctx, check);
    case 'serve-isolation':
      return runIsolationCheck(ctx, check);
    case 'no-rogue-tools':
      return runNoRogueToolsCheck(ctx);
  }
}

async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    const started = Date.now();
    let verdict: Verdict;
    try {
      verdict = await runCheck(ctx, check);
    } catch (err) {
      verdict = { status: 'fail', detail: `runner error: ${String(err)}` };
    }
    const latencyMs = Date.now() - started;
    const expectedUnknown = check.kind === 'pack-vocab' ? check.expectedUnknown : undefined;
    const result: CheckResult = {
      id: check.id,
      kind: check.kind,
      cls: check.cls,
      status: verdict.status,
      detail: verdict.detail,
      latencyMs,
      ...(verdict.answer !== undefined ? { answer: verdict.answer } : {}),
      ...(expectedUnknown !== undefined ? { expectedUnknown } : {}),
    };
    results.push(result);
    const note =
      verdict.status === 'fail' && expectedUnknown !== undefined ? ' (baseline finding)' : '';
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
    install: emptyTally(),
    'pack-vocab': emptyTally(),
    'pack-transition': emptyTally(),
    'cross-entity': emptyTally(),
    'trace-provenance': emptyTally(),
    'trace-interleave': emptyTally(),
    'serve-cross': emptyTally(),
    'serve-isolation': emptyTally(),
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
    ingest: { mentionTurns: cfg.skipIngest ? 0 : ALL_TURNS.length },
    classes,
    checkKinds,
    checks,
    results,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(`domain-packs scorecard — run ${card.runId} (guardrails=${card.guardrails})`);
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
        ? ` — ${card.checks.failedExpectedUnknown} fail(s) are the pack-vocab baseline finding`
        : ''),
  );
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(`domain-packs: run ${cfg.runId} against ${cfg.baseUrl} (tenant ${cfg.companyId})`);

  const setup = await ensurePackSetup(cfg);

  const brain = new HttpBrainClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const mcp = await connectMcp(cfg);
  try {
    const toolList = await withRetry('tools/list', () => mcp.listTools());
    const tools = new Set(toolList.tools.map((t) => t.name));
    console.error(`[mcp] connected, ${tools.size} tools visible`);

    if (!cfg.skipIngest) {
      await ingestTurns(cfg, brain);
    }

    const results = await runChecks({ cfg, mcp, tools });
    const card = buildScorecard(cfg, startedAt, setup, results);

    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `domain-packs-${cfg.runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
    printScorecard(card);
    console.log(`report: ${reportPath}`);
  } finally {
    await mcp.close();
  }
}

void main().catch((err: unknown) => {
  console.error('domain-packs: runner failed:', err);
  process.exitCode = 1;
});
