/**
 * Memory-fitness runner — drives EVERYTHING through the real wire:
 *
 *  - REST  POST /v1/ingest/mention            (corpus turns, per-user scoped)
 *  - MCP   record_fact                        (direct facts, grounding mix)
 *  - REST  POST /v1/admin/maintenance/scenes | scenes/backlink | scenes/beliefs
 *          (best-effort admin builds; enrich runs in-build when
 *          SCENES_LLM_ENRICHMENT is on; 404 = flag off = the dependent
 *          question is skipped, never silently passed)
 *  - MCP   synthesize / search_knowledge / search_multi_hop /
 *          get_entity_timeline / get_fact_provenance / get_competing_facts
 *  - REST  GET /v1/beliefs                    (belief read API)
 *
 * Scoring is fully mechanical (see scorers.ts) — no LLM judge. The
 * serving calls cost normal model spend on the stand; the harness
 * itself spends nothing on judging.
 *
 * Run: pnpm eval:memory-fitness   (see README.md for stand flags)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HttpBrainClient } from '../http-brain-client';
import {
  CORPUS_TURNS,
  CORPUS_VERTICAL,
  DIRECT_FACTS,
  LEDGER_SYNC_REF,
  MERIDIAN_REF,
  SPEAKER,
} from './corpus';
import { interleaveRoundRobin } from './interleave';
import { QUESTIONS } from './questions';
import {
  checkEvolution,
  classifyConflictAnswer,
  containsAnyOf,
  findForbidden,
  isAbstention,
  matchesDate,
  missingKeyPhrases,
  walkProvenance,
  type EvolutionEvent,
} from './scorers';
import type { DimensionTally, Dimension, Question, QuestionResult, Scorecard } from './types';

/**
 * Provenance-walk budget (d3): how many candidate facts get their
 * provenance unrolled per question. Candidates are interleaved
 * round-robin across search hits (interleave.ts) before this cap.
 */
const PROVENANCE_CANDIDATE_CAP = 12;

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
        'memory-fitness: BRAIN_BASE_URL is not set — nothing to run against.',
        'This harness drives a LIVE brain stand over MCP + REST (it needs a booted',
        'service and its OpenAI key) and is intentionally never run in CI.',
        '',
        'Required env:',
        '  BRAIN_BASE_URL   e.g. http://localhost:3000  (BRAIN_URL also accepted)',
        '  BRAIN_API_KEY    tenant M2M key with brain:read + brain:write',
        '                   (+ brain:admin for the optional scene/belief builds)',
        '  BRAIN_COMPANY_ID tenant id — use a FRESH tenant per run (see README.md)',
        '',
        'Optional env: MEMFIT_USER_ID, MEMFIT_RUN_ID, MEMFIT_GUARDRAILS',
        '(strict|lenient|off, default strict), MEMFIT_SKIP_INGEST=1 (re-ask an',
        'already-ingested run — requires the same MEMFIT_RUN_ID), MEMFIT_REPORT_DIR.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (apiKey === undefined || apiKey === '') {
    console.error('memory-fitness: BRAIN_API_KEY is not set.');
    process.exit(1);
  }
  if (companyId === undefined || companyId === '') {
    console.error('memory-fitness: BRAIN_COMPANY_ID is not set.');
    process.exit(1);
  }
  const guardrailsRaw = process.env.MEMFIT_GUARDRAILS ?? 'strict';
  if (guardrailsRaw !== 'strict' && guardrailsRaw !== 'lenient' && guardrailsRaw !== 'off') {
    console.error(`memory-fitness: MEMFIT_GUARDRAILS must be strict|lenient|off.`);
    process.exit(1);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    companyId,
    userId: process.env.MEMFIT_USER_ID ?? 'memfit-agent',
    runId: process.env.MEMFIT_RUN_ID ?? `mf${Date.now().toString(36)}`,
    guardrails: guardrailsRaw,
    skipIngest: process.env.MEMFIT_SKIP_INGEST === '1',
    reportDir: process.env.MEMFIT_REPORT_DIR ?? join('var', 'memory-fitness'),
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

/** Expand corpus-local evidence refs (`c3`, `c2:t08`) to run-scoped ids. */
function expandEvidenceRef(cfg: Config, kind: string, ref: string): string {
  if (kind === 'conversation' && /^c\d$/.test(ref)) return convId(cfg, ref);
  const m = /^(c\d):t(\d+)$/.exec(ref);
  if (kind === 'message' && m !== null && m[1] !== undefined && m[2] !== undefined) {
    return messageId(cfg, m[1], Number(m[2]));
  }
  return ref;
}

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
  const client = new McpClient({ name: 'memory-fitness-harness', version: '1.0.0' });
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
interface MultiHopOut {
  synthesis?: { answer: string | null; reason?: string };
}
interface TimelineOut {
  events?: Array<{ type: string; at: string; predicate?: string; object?: string }>;
}
interface CompetingOut {
  groups?: Array<{ predicate: string; facts?: Array<{ object: string }> }>;
}
interface ProvenanceOut {
  factId?: string;
  episodes?: Array<{ episodeId?: string; text?: string }>;
}
interface BeliefsOut {
  beliefs?: Array<{ subject: string; field: string; value: string; priorValue?: string }>;
}
interface RecordFactOut {
  factId: string | null;
  outcome?: string;
}

// ── phase 1: write the agent's memory ───────────────────────────────

async function ingestCorpus(cfg: Config, brain: HttpBrainClient): Promise<void> {
  console.error(`[ingest] ${CORPUS_TURNS.length} mention turns (run ${cfg.runId})…`);
  for (const [i, turn] of CORPUS_TURNS.entries()) {
    const knownEntities: Array<Record<string, string>> = [
      { ...SPEAKER },
      { ...LEDGER_SYNC_REF, name: 'ledger-sync' },
    ];
    if (turn.text.includes('Meridian')) {
      knownEntities.push({ ...MERIDIAN_REF, name: 'Meridian' });
    }
    await withRetry(`mention ${turn.conversation}#${turn.turn}`, () =>
      brain.ingest.mention({
        text: turn.text,
        contextRef: {
          vertical: CORPUS_VERTICAL,
          conversationId: convId(cfg, turn.conversation),
          messageId: messageId(cfg, turn.conversation, turn.turn),
          recorder: 'memory-fitness-harness',
        },
        knownEntities,
        userId: cfg.userId,
        emittedAt: turn.emittedAt,
      }),
    );
    if ((i + 1) % 10 === 0) console.error(`[ingest] ${i + 1}/${CORPUS_TURNS.length}`);
  }
}

async function recordDirectFacts(cfg: Config, mcp: McpClient): Promise<void> {
  console.error(`[record] ${DIRECT_FACTS.length} direct record_fact calls…`);
  for (const fact of DIRECT_FACTS) {
    const args: Record<string, unknown> = {
      entityRef: fact.entityRef,
      predicate: fact.predicate,
      object: fact.object,
      validFrom: fact.validFrom,
      sourceVertical: CORPUS_VERTICAL,
      userId: cfg.userId,
    };
    if (fact.validUntil !== undefined) args.validUntil = fact.validUntil;
    if (fact.confidence !== undefined) args.confidence = fact.confidence;
    if (fact.conversation !== undefined) args.conversationId = convId(cfg, fact.conversation);
    if (fact.evidence !== undefined) {
      args.evidence = fact.evidence.map((ev) => ({
        kind: ev.kind,
        ref: expandEvidenceRef(cfg, ev.kind, ev.ref),
        ...(ev.note !== undefined ? { note: ev.note } : {}),
      }));
    }
    const out = await callTool<RecordFactOut>(mcp, 'record_fact', args);
    console.error(`[record] ${fact.key}: ${out.outcome ?? 'ok'}`);
  }
}

async function runBuilds(cfg: Config): Promise<Record<string, string>> {
  // scenes -> (enrich happens in-build when SCENES_LLM_ENRICHMENT is on)
  // -> backlink -> beliefs. Every step is best-effort: a 404 means the
  // stand runs without that flag and the dependent question is SKIPPED.
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

// ── phase 2: ask and score ──────────────────────────────────────────

interface AskContext {
  cfg: Config;
  mcp: McpClient;
  tools: Set<string>;
  builds: Record<string, string>;
}

async function synthesizeAnswer(ctx: AskContext, query: string): Promise<SynthOut> {
  return callTool<SynthOut>(ctx.mcp, 'synthesize', {
    query,
    limit: 15,
    synthesisGuardrails: ctx.cfg.guardrails,
    userId: ctx.cfg.userId,
  });
}

async function searchHits(ctx: AskContext, query: string, limit: number): Promise<SearchHit[]> {
  const out = await callTool<SearchOut>(ctx.mcp, 'search_knowledge', {
    query,
    limit,
    userId: ctx.cfg.userId,
  });
  return out.results ?? [];
}

/** Resolve the entity that carries `predicate`, else best-name match. */
async function resolveEntityId(
  ctx: AskContext,
  query: string,
  predicate?: string,
): Promise<string | null> {
  const hits = await searchHits(ctx, query, 10);
  if (predicate !== undefined) {
    const withPredicate = hits.find((h) => (h.facts ?? []).some((f) => f.predicate === predicate));
    if (withPredicate !== undefined) return withPredicate.entityId;
  }
  return hits[0]?.entityId ?? null;
}

type Verdict = Pick<QuestionResult, 'status' | 'detail'> & { answer?: string | null };

async function askOne(ctx: AskContext, q: Question): Promise<Verdict> {
  switch (q.kind) {
    case 'currency': {
      const out = await synthesizeAnswer(ctx, q.prompt);
      if (isAbstention(out.answer, out.reason)) {
        return { status: 'fail', detail: 'abstained on a known value', answer: out.answer };
      }
      const answer = out.answer ?? '';
      const stale = findForbidden(answer, q.forbidAnyOf);
      if (stale !== null) {
        return { status: 'fail', detail: `stale value served: "${stale}"`, answer };
      }
      return containsAnyOf(answer, q.expectAnyOf)
        ? { status: 'pass', detail: 'current value served, stale value absent', answer }
        : { status: 'fail', detail: `expected one of [${q.expectAnyOf.join(', ')}]`, answer };
    }
    case 'evolution': {
      const entityId = await resolveEntityId(ctx, q.entityQuery, q.predicate);
      if (entityId === null) return { status: 'fail', detail: 'entity not found via search' };
      const timeline = await callTool<TimelineOut>(ctx.mcp, 'get_entity_timeline', {
        entityId,
        userId: ctx.cfg.userId,
      });
      const events: EvolutionEvent[] = (timeline.events ?? [])
        .filter((e) => e.type === 'fact.recorded')
        .map((e) => ({ predicate: e.predicate ?? '', object: e.object ?? '', at: e.at }));
      const verdict = checkEvolution(events, q.predicate, q.oldMarkers, q.newMarkers);
      return { status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail };
    }
    case 'belief-evolution': {
      if (ctx.builds['scenes/beliefs'] !== 'ok') {
        return {
          status: 'skipped',
          detail: `belief build not run (${ctx.builds['scenes/beliefs'] ?? 'no build phase'})`,
        };
      }
      const res = await restRaw<BeliefsOut>(
        ctx.cfg,
        'GET',
        `/v1/beliefs?userId=${encodeURIComponent(ctx.cfg.userId)}&limit=50`,
      );
      if (res.status === 404) {
        return { status: 'skipped', detail: 'BELIEFS_API_ENABLED off (404)' };
      }
      const beliefs = res.json?.beliefs ?? [];
      const match = beliefs.find(
        (b) =>
          containsAnyOf(b.value, q.valueMarkers) &&
          b.priorValue !== undefined &&
          containsAnyOf(b.priorValue, q.priorMarkers),
      );
      return match !== undefined
        ? {
            status: 'pass',
            detail: `belief (${match.subject}, ${match.field}) holds value + priorValue`,
          }
        : { status: 'fail', detail: `no belief carries value+priorValue (${beliefs.length} read)` };
    }
    case 'provenance': {
      if (!ctx.tools.has('get_fact_provenance')) {
        return { status: 'skipped', detail: 'get_fact_provenance absent (FACTS_API_ENABLED off)' };
      }
      const hits = await searchHits(ctx, q.searchQuery, 8);
      const factIdsPerHit: string[][] = hits.map((hit) => {
        const ids: string[] = [];
        for (const fact of hit.facts ?? []) {
          if (q.predicateHint !== undefined && q.predicateHint !== '') {
            if (!fact.predicate.includes(q.predicateHint)) continue;
          }
          ids.push(fact.factId);
        }
        return ids;
      });
      // Round-robin across hits (hit1.fact1, hit2.fact1, …) so one fat
      // entity cannot monopolise the walk budget — see interleave.ts.
      const candidates = interleaveRoundRobin(factIdsPerHit, PROVENANCE_CANDIDATE_CAP);
      if (candidates.length === 0) {
        return { status: 'fail', detail: 'search returned no candidate facts' };
      }
      for (const factId of candidates) {
        const prov = await callTool<ProvenanceOut>(ctx.mcp, 'get_fact_provenance', { factId });
        const match = walkProvenance(prov, q.episodeFragments);
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
    case 'temporal': {
      const out = await synthesizeAnswer(ctx, q.prompt);
      if (isAbstention(out.answer, out.reason)) {
        return { status: 'fail', detail: 'abstained on a dated decision', answer: out.answer };
      }
      const answer = out.answer ?? '';
      return matchesDate(answer, q.expectDate)
        ? { status: 'pass', detail: `date ${q.expectDate} served`, answer }
        : { status: 'fail', detail: `expected date ${q.expectDate}`, answer };
    }
    case 'absence': {
      const out = await synthesizeAnswer(ctx, q.prompt);
      return isAbstention(out.answer, out.reason)
        ? { status: 'pass', detail: 'honest abstention on never-written topic', answer: out.answer }
        : { status: 'fail', detail: 'confabulated an answer', answer: out.answer };
    }
    case 'conflict-api': {
      const entityId = await resolveEntityId(ctx, q.entityQuery, q.predicate);
      if (entityId === null) return { status: 'fail', detail: 'entity not found via search' };
      const out = await callTool<CompetingOut>(ctx.mcp, 'get_competing_facts', {
        entityId,
        predicate: q.predicate,
        userId: ctx.cfg.userId,
      });
      const group = (out.groups ?? []).find((g) => g.predicate === q.predicate);
      const objects = (group?.facts ?? []).map((f) => f.object).join(' | ');
      const hasA = containsAnyOf(objects, q.sideA);
      const hasB = containsAnyOf(objects, q.sideB);
      if (hasA && hasB) {
        return { status: 'pass', detail: `both sides competing: [${objects}]` };
      }
      return {
        status: 'fail',
        detail:
          group === undefined
            ? 'no competing group for the predicate (conflict auto-resolved?)'
            : `competing group lists only [${objects}]`,
      };
    }
    case 'conflict-answer': {
      const out = await synthesizeAnswer(ctx, q.prompt);
      const verdict = classifyConflictAnswer(out.answer, q.sideA, q.sideB, out.reason);
      switch (verdict) {
        case 'both-sides':
          return { status: 'pass', detail: 'answer names both sides', answer: out.answer };
        case 'abstained':
          return {
            status: 'pass',
            detail: 'abstained rather than pick a side silently',
            answer: out.answer,
          };
        case 'one-sided':
          return {
            status: 'fail',
            detail: 'served one side of a live conflict',
            answer: out.answer,
          };
        case 'neither':
          return { status: 'fail', detail: 'answer names neither side', answer: out.answer };
      }
      break;
    }
    case 'integration': {
      let answer: string | null;
      let reason: string | undefined;
      if (ctx.tools.has('search_multi_hop')) {
        const out = await callTool<MultiHopOut>(ctx.mcp, 'search_multi_hop', {
          query: q.prompt,
          synthesize: true,
          synthesisGuardrails: ctx.cfg.guardrails,
          userId: ctx.cfg.userId,
        });
        answer = out.synthesis?.answer ?? null;
        reason = out.synthesis?.reason;
      } else {
        const out = await synthesizeAnswer(ctx, q.prompt);
        answer = out.answer;
        reason = out.reason;
      }
      if (isAbstention(answer, reason)) {
        return { status: 'fail', detail: 'abstained on a cross-session join', answer };
      }
      return containsAnyOf(answer ?? '', q.expectAnyOf)
        ? { status: 'pass', detail: 'joined across conversations', answer }
        : { status: 'fail', detail: `expected one of [${q.expectAnyOf.join(', ')}]`, answer };
    }
    case 'replay': {
      const out = await synthesizeAnswer(ctx, q.prompt);
      if (isAbstention(out.answer, out.reason)) {
        return { status: 'fail', detail: 'abstained on working knowledge', answer: out.answer };
      }
      const missing = missingKeyPhrases(out.answer ?? '', q.keyPhrases);
      return missing.length === 0
        ? { status: 'pass', detail: 'all key phrases present', answer: out.answer }
        : { status: 'fail', detail: `missing: ${missing.join('; ')}`, answer: out.answer };
    }
  }
  return { status: 'fail', detail: 'unreachable question kind' };
}

async function askAll(ctx: AskContext): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const q of QUESTIONS) {
    const started = Date.now();
    let verdict: Verdict;
    try {
      verdict = await askOne(ctx, q);
    } catch (err) {
      verdict = { status: 'fail', detail: `runner error: ${String(err)}` };
    }
    const latencyMs = Date.now() - started;
    const result: QuestionResult = {
      id: q.id,
      dimension: q.dimension,
      prompt: q.prompt,
      status: verdict.status,
      detail: verdict.detail,
      latencyMs,
      ...(verdict.answer !== undefined ? { answer: verdict.answer } : {}),
    };
    results.push(result);
    console.error(
      `[ask] ${q.id} (${q.dimension}) ${verdict.status} ${latencyMs}ms — ${verdict.detail}`,
    );
  }
  return results;
}

// ── scorecard ───────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<Dimension, string> = {
  D1: 'state currency',
  D2: 'evolution history',
  D3: 'provenance unrollability',
  D4: 'temporal anchors',
  D5: 'absence honesty',
  D6: 'conflict surfacing',
  D7: 'cross-session integration',
  D8: 'self-utility replay',
};

function buildScorecard(
  cfg: Config,
  startedAt: string,
  builds: Record<string, string>,
  questions: QuestionResult[],
): Scorecard {
  const dimensions = {} as Record<Dimension, DimensionTally>;
  for (const d of Object.keys(DIMENSION_LABELS) as Dimension[]) {
    dimensions[d] = { pass: 0, fail: 0, skipped: 0 };
  }
  const overall = { pass: 0, fail: 0, skipped: 0, total: questions.length };
  for (const r of questions) {
    const bucket = r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'skipped';
    dimensions[r.dimension][bucket] += 1;
    overall[bucket] += 1;
  }
  return {
    runId: cfg.runId,
    baseUrl: cfg.baseUrl,
    companyId: cfg.companyId,
    userId: cfg.userId,
    guardrails: cfg.guardrails,
    startedAt,
    finishedAt: new Date().toISOString(),
    ingest: {
      mentionTurns: cfg.skipIngest ? 0 : CORPUS_TURNS.length,
      directFacts: cfg.skipIngest ? 0 : DIRECT_FACTS.length,
      builds,
    },
    dimensions,
    overall,
    questions,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(`memory-fitness scorecard — run ${card.runId} (guardrails=${card.guardrails})`);
  console.log('─'.repeat(72));
  for (const d of Object.keys(DIMENSION_LABELS) as Dimension[]) {
    const t = card.dimensions[d];
    const label = DIMENSION_LABELS[d];
    console.log(
      `${d}  ${label.padEnd(26)} pass ${t.pass}  fail ${t.fail}` +
        (t.skipped > 0 ? `  skipped ${t.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  const scored = card.overall.pass + card.overall.fail;
  const pct = scored === 0 ? 0 : Math.round((card.overall.pass / scored) * 1000) / 10;
  console.log(
    `overall: ${card.overall.pass}/${scored} scored (${pct}%), ` +
      `${card.overall.skipped} skipped of ${card.overall.total}`,
  );
  const latencies = card.questions.map((q) => q.latencyMs).sort((a, b) => a - b);
  const mid = latencies[Math.floor(latencies.length / 2)];
  const max = latencies[latencies.length - 1];
  if (mid !== undefined && max !== undefined) {
    console.log(`latency: median ${mid}ms, max ${max}ms per question`);
  }
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(
    `memory-fitness: run ${cfg.runId} against ${cfg.baseUrl} (tenant ${cfg.companyId})`,
  );

  const brain = new HttpBrainClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const mcp = await connectMcp(cfg);
  try {
    const toolList = await withRetry('tools/list', () => mcp.listTools());
    const tools = new Set(toolList.tools.map((t) => t.name));
    console.error(`[mcp] connected, ${tools.size} tools visible`);

    let builds: Record<string, string> = { scenes: 'skipped: MEMFIT_SKIP_INGEST' };
    if (!cfg.skipIngest) {
      await ingestCorpus(cfg, brain);
      await recordDirectFacts(cfg, mcp);
      builds = await runBuilds(cfg);
    }

    const questions = await askAll({ cfg, mcp, tools, builds });
    const card = buildScorecard(cfg, startedAt, builds, questions);

    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `memory-fitness-${cfg.runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
    printScorecard(card);
    console.log(`report: ${reportPath}`);
  } finally {
    await mcp.close();
  }
}

void main().catch((err: unknown) => {
  console.error('memory-fitness: runner failed:', err);
  process.exitCode = 1;
});
