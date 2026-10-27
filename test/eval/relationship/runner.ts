/**
 * Relationship battery runner — drives everything through the real wire:
 *
 *  - REST  POST /v1/ingest/mention          (corpus turns, Ana's user scope,
 *                                           with the speaker anchored)
 *  - REST  POST /v1/admin/maintenance/extraction (read what was written;
 *                                           404 = extraction is inline)
 *  - MCP   synthesize                       (each probe, through the
 *                                           surface it names)
 *
 * Two surfaces, two credentials: BRAIN_API_KEY is the coach, and
 * REL_ASSISTANT_API_KEY the general assistant. Without the second key
 * both surfaces share one credential; the scorecard says so, and R3 can
 * then only measure what plain brain does — which is the baseline.
 *
 * Scoring is mechanical (scorers.ts) — no LLM judge. The only model
 * spend is the stand's own: extraction on ingest, synthesis per probe.
 *
 * Run: pnpm eval:relationship   (see README.md)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HttpBrainClient } from '../http-brain-client';
import { longRequestJson } from '../long-request';
import { batteryPhase } from '../phase';
import {
  COACH_REF,
  CORPUS_TURNS,
  CORPUS_VERTICAL,
  PERSON_NAME,
  SPECIALIST_REF,
  TIMEZONE,
} from './corpus';
import { RELATIONSHIP_PACK } from '../../../src/ai/domain-packs/relationship.pack';
import { PROBES } from './probes';
import {
  containsAnyOf,
  findForbidden,
  firstUnqualified,
  isAbstention,
  missingKeyPhrases,
  overdueMiss,
  qualifiersFor,
  type ContextCommitment,
} from './scorers';
import type { Check, CorpusTurn, Probe, ProbeResult, Scorecard, Surface, Tally } from './types';

// ── configuration ───────────────────────────────────────────────────

interface Config {
  baseUrl: string;
  coachKey: string;
  assistantKey: string;
  companyId: string;
  userId: string;
  runId: string;
  guardrails: 'strict' | 'lenient' | 'off';
  skipIngest: boolean;
  reportDir: string;
  anchor: Date;
}

function loadConfig(): Config {
  const baseUrl = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL;
  const coachKey = process.env.BRAIN_API_KEY;
  const companyId = process.env.BRAIN_COMPANY_ID;
  if (
    baseUrl === undefined ||
    baseUrl === '' ||
    coachKey === undefined ||
    coachKey === '' ||
    companyId === undefined ||
    companyId === ''
  ) {
    console.error(
      [
        'relationship: nothing to run against.',
        'This harness drives a LIVE brain over MCP + REST and is never run in CI.',
        '',
        'Required env:',
        '  BRAIN_BASE_URL         e.g. https://brain.example',
        '  BRAIN_API_KEY          the COACH surface: brain:read + brain:write (+ brain:admin to drain extraction)',
        '  BRAIN_COMPANY_ID       tenant id — a tenant kept for evals, never a customer one',
        '',
        'Optional env: REL_ASSISTANT_API_KEY (the assistant surface; defaults to the coach key),',
        'REL_USER_ID, REL_RUN_ID, REL_GUARDRAILS (strict|lenient|off, default strict),',
        'REL_SKIP_INGEST=1 (re-ask an ingested run — same REL_RUN_ID and REL_ANCHOR), REL_ANCHOR, REL_REPORT_DIR.',
      ].join('\n'),
    );
    process.exit(1);
  }
  const guardrails = process.env.REL_GUARDRAILS ?? 'strict';
  if (guardrails !== 'strict' && guardrails !== 'lenient' && guardrails !== 'off') {
    console.error('relationship: REL_GUARDRAILS must be strict|lenient|off.');
    process.exit(1);
  }
  const runId = process.env.REL_RUN_ID ?? `rel${Date.now().toString(36)}`;
  const anchor =
    process.env.REL_ANCHOR !== undefined ? new Date(process.env.REL_ANCHOR) : new Date();
  if (Number.isNaN(anchor.getTime())) {
    console.error('relationship: REL_ANCHOR must be an ISO datetime.');
    process.exit(1);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    coachKey,
    assistantKey: process.env.REL_ASSISTANT_API_KEY ?? coachKey,
    companyId,
    // run-scoped: re-runs in one eval tenant never share a participant
    userId: `${process.env.REL_USER_ID ?? 'rel-ana'}-${runId}`,
    runId,
    guardrails,
    skipIngest: process.env.REL_SKIP_INGEST === '1' || batteryPhase() === 'ask',
    reportDir: process.env.REL_REPORT_DIR ?? join('var', 'relationship'),
    anchor,
  };
}

// ── small utilities ─────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry on throttle (HTTP 429 — mention ingest and the MCP route are
 * rate-capped) and, a few times, on a dropped connection: against a
 * live stand behind a proxy, a reset is weather, not a verdict.
 */
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
      if (attempt < 4 && /fetch failed|ECONNRESET|socket hang up|\b52[0-4]\b/i.test(msg)) {
        console.error(`  [network] ${label} — ${msg.slice(0, 80)}; retrying in 10s`);
        await sleep(10_000);
        continue;
      }
      throw err;
    }
  }
}

/** Synthesis behind strict guardrails can take minutes on a busy stand. */
const TOOL_TIMEOUT_MS = 300_000;

const convId = (cfg: Config, key: string): string => `${cfg.runId}-${key}`;
const messageId = (cfg: Config, key: string, turn: number): string =>
  `${convId(cfg, key)}-t${String(turn).padStart(2, '0')}`;
const emittedAt = (cfg: Config, turn: CorpusTurn): string =>
  new Date(cfg.anchor.getTime() - turn.daysAgo * 24 * 3_600_000).toISOString();

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

async function connectMcp(cfg: Config, apiKey: string, surface: Surface): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${cfg.baseUrl}/mcp/${cfg.companyId}`),
    {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    },
  );
  const client = new McpClient({ name: `relationship-harness-${surface}`, version: '1.0.0' });
  // The SDK's own .d.ts disagrees with itself under exactOptionalPropertyTypes
  // (see memory-fitness/runner.ts); the runtime value is a valid Transport.
  await client.connect(transport as Transport);
  return client;
}

async function callTool<T>(
  mcp: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const raw = (await withRetry(name, () =>
    mcp.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS }),
  )) as ToolCallShape;
  const text = textOf(raw);
  if (raw.isError === true)
    throw new Error(`MCP tool ${name} failed: ${text ?? '(no error text)'}`);
  if (text !== null) return JSON.parse(text) as T;
  if (raw.structuredContent !== undefined) return raw.structuredContent as T;
  throw new Error(`MCP tool ${name} returned neither text nor structuredContent`);
}

interface SynthOut {
  answer: string | null;
  reason?: string;
}

// ── phase 1: write two weeks of the programme ───────────────────────

function knownEntitiesFor(cfg: Config, turn: CorpusTurn): Array<Record<string, string>> {
  const person = { vertical: 'user', id: cfg.userId, name: PERSON_NAME };
  switch (turn.speaker) {
    case 'person':
      return [{ ...person, role: 'speaker' }];
    case 'coach':
      return [
        { ...COACH_REF, role: 'speaker' },
        { ...person, role: 'addressee' },
      ];
    case 'specialist':
      return [{ ...SPECIALIST_REF, role: 'speaker' }, person];
  }
}

async function ingestCorpus(cfg: Config, brain: HttpBrainClient): Promise<void> {
  console.error(`[ingest] ${CORPUS_TURNS.length} turns (run ${cfg.runId})…`);
  for (const turn of CORPUS_TURNS) {
    await withRetry(`mention ${turn.conversation}#${turn.turn}`, () =>
      brain.ingest.mention({
        text: turn.text,
        contextRef: {
          vertical: CORPUS_VERTICAL,
          conversationId: convId(cfg, turn.conversation),
          messageId: messageId(cfg, turn.conversation, turn.turn),
          recorder: 'relationship-harness',
        },
        knownEntities: knownEntitiesFor(cfg, turn),
        userId: cfg.userId,
        emittedAt: emittedAt(cfg, turn),
        timezone: TIMEZONE,
      }),
    );
  }
}

/** Ask the server to read everything waiting; 404 = it reads on the write path. */
/**
 * The relationship pack, installed before the corpus is written so its
 * vocabulary reaches the extractor and relationship_context is listed —
 * the stand a relationship tenant runs. Read from src, so the snapshot key
 * (the src tree) moves with it. A 409 is an install already there.
 */
async function installPack(cfg: Config): Promise<void> {
  if (process.env.REL_INSTALL_PACK === '0') return;
  const res = await longRequestJson(
    `${cfg.baseUrl}/v1/admin/packs`,
    'POST',
    { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.coachKey}` },
    { manifest: RELATIONSHIP_PACK },
  );
  const ok = (res.status >= 200 && res.status < 300) || res.status === 409;
  console.error(
    `[build] relationship pack v${RELATIONSHIP_PACK.version}: ${ok ? `installed (${res.status})` : `HTTP ${res.status} ${JSON.stringify(res.json)} — the stand runs without it`}`,
  );
}

async function drainExtraction(cfg: Config): Promise<void> {
  // Can outlive fetch's 300 s header deadline (long-request.ts). Behind a
  // proxy it can also outlive the proxy (Cloudflare answers 524 at 100 s):
  // re-ask with REL_SKIP_INGEST once a second drain answers `read: 0`.
  const res = await longRequestJson(
    `${cfg.baseUrl}/v1/admin/maintenance/extraction`,
    'POST',
    { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.coachKey}` },
    {},
  );
  const ok = res.status >= 200 && res.status < 300;
  console.error(
    `[build] extraction: ${res.status === 404 ? 'inline (404)' : ok ? `drained ${JSON.stringify(res.json)}` : `HTTP ${res.status} — probes may see a partial read`}`,
  );
}

// ── phase 2: ask and score ──────────────────────────────────────────

interface AskContext {
  cfg: Config;
  surfaces: Record<Surface, McpClient>;
  tools: Set<string>;
}

type Verdict = Pick<ProbeResult, 'status' | 'detail' | 'answer' | 'otherAnswer'>;

async function synthesize(ctx: AskContext, surface: Surface, query: string): Promise<SynthOut> {
  return callTool<SynthOut>(ctx.surfaces[surface], 'synthesize', {
    query,
    limit: 15,
    synthesisGuardrails: ctx.cfg.guardrails,
    userId: ctx.cfg.userId,
  });
}

const withReason = (detail: string, reason: string | undefined): string =>
  reason ? `${detail} (reason: ${reason})` : detail;

async function askOne(ctx: AskContext, p: Probe): Promise<Verdict> {
  switch (p.kind) {
    case 'overdue': {
      if (!ctx.tools.has(p.tool))
        return { status: 'skipped', detail: `${p.tool} not listed on this stand` };
      const out = await callTool<{ commitments?: ContextCommitment[] }>(
        ctx.surfaces[p.surface],
        p.tool,
        { userId: ctx.cfg.userId },
      );
      const miss = overdueMiss(out.commitments ?? [], p.markers);
      return miss === null
        ? { status: 'pass', detail: 'flagged overdue', answer: JSON.stringify(out.commitments) }
        : { status: 'fail', detail: miss, answer: JSON.stringify(out.commitments ?? []) };
    }
    case 'requires':
      return ctx.tools.has(p.tool)
        ? { status: 'fail', detail: `${p.tool} is listed but this probe has no scorer yet` }
        : { status: 'skipped', detail: `${p.tool} not listed on this stand` };
    case 'expect': {
      const out = await synthesize(ctx, p.surface, p.prompt);
      if (isAbstention(out.answer, out.reason)) {
        return {
          status: 'fail',
          detail: withReason('abstained on what the memory holds', out.reason),
          answer: out.answer,
        };
      }
      const missing = missingKeyPhrases(out.answer ?? '', p.groups);
      return missing.length === 0
        ? { status: 'pass', detail: 'all expected markers present', answer: out.answer }
        : { status: 'fail', detail: `missing: ${missing.join('; ')}`, answer: out.answer };
    }
    case 'fence': {
      const own = await synthesize(ctx, 'coach', p.prompt);
      const other = await synthesize(ctx, 'assistant', p.prompt);
      const owned =
        !isAbstention(own.answer, own.reason) && containsAnyOf(own.answer ?? '', p.ownerAnyOf);
      const leaked = findForbidden(other.answer ?? '', p.forbidForOthers);
      const base = { answer: own.answer, otherAnswer: other.answer };
      if (!owned)
        return {
          status: 'fail',
          detail: withReason('the coach did not get its own disclosure', own.reason),
          ...base,
        };
      if (leaked !== null)
        return { status: 'fail', detail: `leaked to the assistant: "${leaked}"`, ...base };
      return { status: 'pass', detail: 'the coach has it, the assistant does not', ...base };
    }
    case 'qualified': {
      const out = await synthesize(ctx, p.surface, p.prompt);
      const abstained = isAbstention(out.answer, out.reason);
      if (p.expectAnyOf !== undefined) {
        if (abstained)
          return {
            status: 'fail',
            detail: withReason('abstained on what the memory holds', out.reason),
            answer: out.answer,
          };
        if (!containsAnyOf(out.answer ?? '', p.expectAnyOf)) {
          return {
            status: 'fail',
            detail: `expected one of [${p.expectAnyOf.join(', ')}]`,
            answer: out.answer,
          };
        }
      } else if (abstained) {
        return { status: 'pass', detail: withReason('abstained', out.reason), answer: out.answer };
      }
      const bare = firstUnqualified(out.answer ?? '', p.markers, qualifiersFor(p.qualifiers));
      return bare === null
        ? {
            status: 'pass',
            detail: `markers absent or told as ${p.qualifiers}`,
            answer: out.answer,
          }
        : { status: 'fail', detail: `told as current/known: "${bare}"`, answer: out.answer };
    }
    case 'absence': {
      const out = await synthesize(ctx, p.surface, p.prompt);
      return isAbstention(out.answer, out.reason)
        ? { status: 'pass', detail: withReason('abstained', out.reason), answer: out.answer }
        : { status: 'fail', detail: 'answered a never-written topic', answer: out.answer };
    }
  }
}

async function askAll(ctx: AskContext): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const p of PROBES) {
    const started = Date.now();
    let verdict: Verdict;
    try {
      verdict = await askOne(ctx, p);
    } catch (err) {
      verdict = { status: 'fail', detail: `runner error: ${String(err)}` };
    }
    const latencyMs = Date.now() - started;
    results.push({
      id: p.id,
      check: p.check,
      surface: p.surface,
      prompt: p.prompt,
      latencyMs,
      ...verdict,
    });
    console.error(
      `[ask] ${p.id} (${p.check}, ${p.surface}) ${verdict.status} ${latencyMs}ms — ${verdict.detail}`,
    );
  }
  return results;
}

// ── report ──────────────────────────────────────────────────────────

const CHECK_LABELS: Record<Check, string> = {
  R1: 'no stale state',
  R2: 'boundaries travel',
  R3: 'no leaks',
  R4: 'commitments survive',
  R5: 'guess is not fact',
  R6: 'revocation holds',
  R7: 'voice is separable',
  R8: 'hypothesis confirmed by person',
  R9: 'what helped',
  A1: 'absence (control)',
};

function buildScorecard(cfg: Config, startedAt: string, probes: ProbeResult[]): Scorecard {
  const checks = {} as Record<Check, Tally>;
  for (const c of Object.keys(CHECK_LABELS) as Check[])
    checks[c] = { pass: 0, fail: 0, skipped: 0 };
  const overall = { pass: 0, fail: 0, skipped: 0, total: probes.length };
  for (const r of probes) {
    checks[r.check][r.status] += 1;
    overall[r.status] += 1;
  }
  return {
    runId: cfg.runId,
    baseUrl: cfg.baseUrl,
    companyId: cfg.companyId,
    guardrails: cfg.guardrails,
    distinctSurfaces: cfg.assistantKey !== cfg.coachKey,
    startedAt,
    finishedAt: new Date().toISOString(),
    anchor: cfg.anchor.toISOString(),
    turns: cfg.skipIngest ? 0 : CORPUS_TURNS.length,
    checks,
    overall,
    probes,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(
    `relationship scorecard — run ${card.runId} (guardrails=${card.guardrails}, ` +
      `${card.distinctSurfaces ? 'two credentials' : 'ONE credential for both surfaces'})`,
  );
  console.log('─'.repeat(72));
  for (const c of Object.keys(CHECK_LABELS) as Check[]) {
    const t = card.checks[c];
    console.log(
      `${c.padEnd(3)} ${CHECK_LABELS[c].padEnd(32)} pass ${t.pass}  fail ${t.fail}` +
        (t.skipped > 0 ? `  skipped ${t.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  const scored = card.overall.pass + card.overall.fail;
  console.log(
    `overall: ${card.overall.pass}/${scored} scored, ${card.overall.skipped} skipped of ${card.overall.total}`,
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(`relationship: run ${cfg.runId} against ${cfg.baseUrl} (tenant ${cfg.companyId})`);

  const brain = new HttpBrainClient({ baseUrl: cfg.baseUrl, apiKey: cfg.coachKey });
  const coach = await connectMcp(cfg, cfg.coachKey, 'coach');
  const assistant = await connectMcp(cfg, cfg.assistantKey, 'assistant');
  try {
    if (!cfg.skipIngest) {
      await installPack(cfg);
      await ingestCorpus(cfg, brain);
      await drainExtraction(cfg);
    }
    // Listed after the install: the pack switches relationship_context on.
    const toolList = await withRetry('tools/list', () => assistant.listTools());
    const tools = new Set(toolList.tools.map((t) => t.name));
    console.error(`[mcp] connected, ${tools.size} tools visible to the assistant`);
    if (batteryPhase() === 'ingest') {
      console.log(`relationship: ingested run ${cfg.runId}, nothing asked (BATTERY_PHASE=ingest)`);
      return;
    }

    const probes = await askAll({ cfg, surfaces: { coach, assistant }, tools });
    const card = buildScorecard(cfg, startedAt, probes);
    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `relationship-${cfg.runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
    printScorecard(card);
    console.log(`report: ${reportPath}`);
  } finally {
    await coach.close();
    await assistant.close();
  }
}

void main().catch((err: unknown) => {
  console.error('relationship: runner failed:', err);
  process.exitCode = 1;
});
