/**
 * HaluMem runner — operation-level hallucination evaluation of brain as an
 * agent memory (arXiv 2511.03506; toolkit github.com/MemTensor/HaluMem).
 *
 * Phase 1 (the system) drives a booted stand over the wire, user by user,
 * session by session, in order:
 *  - add:      each session is ONE chat document (POST /v1/ingest/document,
 *              the user's own scope); what it committed is the session's
 *              extracted memory, rendered `Entity — predicate: object`;
 *  - update:   for every gold point that updates an earlier one, the
 *              top-10 memories a search for it returns;
 *  - QA:       every question, answered by brain's own synthesize
 *              (abstention = "I don't know").
 * Phase 2 (the judge) runs the toolkit's four judge prompts, verbatim, on
 * the judge model, and aggregates exactly as evaluation.py does.
 *
 * Phase 1 checkpoints per user (HALUMEM_RUN_ID) and a finished system file
 * can be judged again alone (HALUMEM_SYSTEM_FILE). Never run in CI.
 *
 * HALUMEM_MODEL=harness runs with no model key at all, against a stand in
 * harness mode (EXTRACTION_SOURCE=harness): the connected agent does every
 * model reading. Extraction reaches it through take_memory_work, as in
 * production. The answers and the judge verdicts go through files: the run
 * writes `…-answers-requests.jsonl` / `…-judge-requests.jsonl` (id +
 * the exact prompt), stops, and is resumed with the agent's replies in
 * `…-answers.jsonl` / `…-judge.jsonl` (id + reply). The answer is the
 * toolkit's own answerer (PROMPT_ZEP) over the evidence brain's MCP
 * synthesize hands back in harness mode.
 *
 * Run: pnpm eval:halumem   (README.md lists the env)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { runPool } from '../harness/pool';
import { appendCheckpoint, loadCheckpoint } from '../checkpoint';
import {
  haluMemTime,
  judgeDialogue,
  loadHaluMem,
  sessionTranscript,
  userNameOf,
  type HaluMemPoint,
  type HaluMemQuestion,
  type HaluMemUser,
} from './dataset';
import {
  f1,
  judgeJson,
  loadHaluMemPrompts,
  pyFormat,
  scoreAccuracy,
  scoreIntegrity,
  scoreQa,
  scoreQaByType,
  scoreUpdates,
  type AccuracyRecord,
  type HaluMemPrompts,
  type IntegrityRecord,
  type QaRecord,
  type UpdateRecord,
} from './protocol';

// ── configuration ───────────────────────────────────────────────────

interface Config {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  data: string;
  repo: string;
  users: number;
  sessions: number;
  concurrency: number;
  judgeConcurrency: number;
  judgeModel: string;
  runId: string;
  reportDir: string;
  systemFile: string | undefined;
  ingest: 'async' | 'sync';
  /** Longest wait for one async document to be processed, ms. */
  settleTimeoutMs: number;
  /** Who answers and judges: the OpenAI-compatible model, or the connected agent through files. */
  model: 'openai' | 'harness';
}

const intEnv = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k]?.trim() ? v : d;
};

function loadConfig(): Config {
  const need = (k: string, hint: string): string => {
    const v = process.env[k];
    if (!v) {
      console.error(`halumem: ${k} is not set — ${hint}`);
      process.exit(2);
    }
    return v;
  };
  const systemFile = process.env.HALUMEM_SYSTEM_FILE || undefined;
  const judgeOnly = systemFile !== undefined;
  return {
    baseUrl: judgeOnly ? '' : need('BRAIN_BASE_URL', 'e.g. http://localhost:3000'),
    apiKey: judgeOnly ? '' : need('BRAIN_API_KEY', 'a tenant key with brain:read + brain:write'),
    companyId: judgeOnly ? '' : need('BRAIN_COMPANY_ID', 'use a FRESH tenant per run'),
    data: judgeOnly ? '' : need('HALUMEM_DATA', 'path to HaluMem-Medium.jsonl (Hugging Face)'),
    repo: need('HALUMEM_REPO', 'path to a checkout of github.com/MemTensor/HaluMem'),
    users: intEnv('HALUMEM_USERS', 2),
    sessions: intEnv('HALUMEM_SESSIONS', 10),
    concurrency: intEnv('HALUMEM_CONCURRENCY', 2),
    judgeConcurrency: intEnv('HALUMEM_JUDGE_CONCURRENCY', 8),
    judgeModel: process.env.HALUMEM_JUDGE_MODEL ?? 'gpt-6-luna',
    runId: process.env.HALUMEM_RUN_ID ?? `hm${Date.now().toString(36)}`,
    reportDir: process.env.HALUMEM_REPORT_DIR ?? 'var/halumem',
    systemFile,
    ingest: process.env.HALUMEM_INGEST === 'sync' ? 'sync' : 'async',
    settleTimeoutMs: intEnv('HALUMEM_SETTLE_TIMEOUT_MS', 900_000),
    model: process.env.HALUMEM_MODEL === 'harness' ? 'harness' : 'openai',
  };
}

// ── the system's output (phase 1), in the toolkit's shape ────────────

interface SystemQuestion extends HaluMemQuestion {
  /** 'protocol' only on system files written before the arm was dropped — not judged. */
  arm?: string;
  system_response: string;
  context?: string;
  /** Harness mode: brain returned evidence and no answer; the agent's answer is still to come. */
  pending?: boolean;
  /**
   * Harness mode: the same question with `detail: "full"`, read at the
   * same moment, rendered as memory lines — what the agent gets when it
   * follows the evidence view's "(+N more …)" hint (it answers EXPAND).
   */
  context_full?: string;
}

interface SystemSession {
  dialogue_for_judge: string;
  memory_points: Array<HaluMemPoint & { memories_from_system?: string[] }>;
  extracted_memories: string[];
  questions: SystemQuestion[];
  add_duration_ms: number;
  /** Until the write was acknowledged (async: receipt; sync: == add_duration_ms). */
  ack_ms?: number;
}

interface SystemUser {
  uuid: string;
  user_name: string;
  sessions: SystemSession[];
}

// ── brain over the wire ──────────────────────────────────────────────

class Brain {
  constructor(private readonly cfg: Config) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
    }
  }

  /**
   * Write one session and wait until brain has processed it; what it
   * committed comes back either way. The one place the ingest contract
   * lives — swap it here when the contract moves.
   *
   * async (default): POST `mode: 'async'` returns at receipt; the
   * document's status runs indexing → indexed → committed (or failed),
   * and the committed ids are the `commitRef`s of its candidates.
   * sync: the POST returns after the commit with the ids inline.
   */
  async ingestSession(body: Record<string, unknown>): Promise<IngestOutcome> {
    const started = Date.now();
    if (this.cfg.ingest === 'sync') {
      const doc = await this.call<{ committed: { entityIds: string[]; factIds: string[] } }>(
        'POST',
        '/v1/ingest/document',
        body,
      );
      const ms = Date.now() - started;
      return { ...doc.committed, ackMs: ms, settledMs: ms };
    }
    const ack = await this.call<{ documentId: string }>('POST', '/v1/ingest/document', {
      ...body,
      mode: 'async',
    });
    const ackMs = Date.now() - started;
    const path = `/v1/documents/${encodeURIComponent(ack.documentId)}`;
    for (;;) {
      const doc = await this.call<{ status?: string }>('GET', path);
      if (doc.status === 'committed') break;
      if (doc.status === 'failed') throw new Error(`document ${ack.documentId} failed`);
      if (Date.now() - started > this.cfg.settleTimeoutMs) {
        throw new Error(
          `document ${ack.documentId} still ${doc.status} after ${this.cfg.settleTimeoutMs} ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    const settledMs = Date.now() - started;
    const { candidates } = await this.call<{
      candidates: Array<{ kind: string; status: string; commitRef?: string }>;
    }>('GET', `${path}/candidates`);
    const refs = (kind: string) => [
      ...new Set(
        candidates
          .filter(
            (c) => c.kind === kind && c.commitRef && ['committed', 'duplicate'].includes(c.status),
          )
          .map((c) => c.commitRef!),
      ),
    ];
    return { entityIds: refs('entity'), factIds: refs('fact'), ackMs, settledMs };
  }

  /**
   * The MCP synthesize tool, as a connected agent calls it. In harness mode
   * the answer is null and `evidence` is the focus view the agent reads.
   */
  async mcpSynthesize(
    query: string,
    userId: string,
    detail?: 'full',
  ): Promise<{ answer: string | null; evidence?: string; results?: SearchHit[] }> {
    const res = await fetch(`${this.cfg.baseUrl}/mcp/${encodeURIComponent(this.cfg.companyId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'synthesize', arguments: { query, userId, ...(detail ? { detail } : {}) } },
      }),
    });
    const raw = await res.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    const rpc = JSON.parse(line ? line.slice(6) : raw) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message: string };
    };
    const text = rpc.result?.content?.[0]?.text;
    if (!text || rpc.error || rpc.result?.isError) {
      throw new Error(`MCP synthesize: ${rpc.error?.message ?? text ?? raw.slice(0, 200)}`);
    }
    return JSON.parse(text) as { answer: string | null; evidence?: string; results?: SearchHit[] };
  }

  /** Search hits as memory lines: `YYYY-MM-DD: Entity — predicate: object`. */
  async memoryLines(query: string, userId: string, limit: number): Promise<string[]> {
    const r = await this.call<{ results: SearchHit[] }>('POST', '/v1/search', {
      query,
      userId,
      limit,
    });
    const lines: Array<{ line: string; score: number }> = [];
    for (const hit of r.results ?? []) {
      for (const f of hit.facts ?? []) {
        lines.push({
          line: `${String(f.validFrom ?? '').slice(0, 10)}: ${hit.canonicalName} — ${f.predicate}: ${f.object}`,
          score: f.score ?? hit.score ?? 0,
        });
      }
    }
    return lines
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((l) => l.line);
  }

  /**
   * What one document committed, as memory lines. The entity's name comes
   * from its profile; its facts from the timeline read in the user's own
   * scope — the profile route takes no userId, and the user's facts sit
   * behind the per-user fence (fail-closed).
   */
  async committedLines(entityIds: string[], factIds: string[], userId: string): Promise<string[]> {
    const want = new Set(factIds);
    const lines = new Map<string, string>();
    for (const id of entityIds) {
      const path = `/v1/entities/${encodeURIComponent(id)}`;
      const profile = await this.call<{ canonicalName: string }>('GET', path).catch(() => null);
      const timeline = await this.call<Timeline>(
        'GET',
        `${path}/timeline?userId=${encodeURIComponent(userId)}`,
      ).catch(() => null);
      for (const e of timeline?.events ?? []) {
        if (e.factId && want.has(e.factId) && !lines.has(e.factId)) {
          lines.set(e.factId, `${profile?.canonicalName ?? id} — ${e.predicate}: ${e.object}`);
        }
      }
    }
    // A fact no committed entity's timeline shows still counts as extracted.
    for (const id of factIds) {
      if (lines.has(id)) continue;
      const f = await this.call<{ aspect: string; statement: string }>(
        'GET',
        `/v1/facts/${encodeURIComponent(id)}`,
      ).catch(() => null);
      if (f) lines.set(id, `${f.aspect}: ${f.statement}`);
    }
    return [...lines.values()];
  }
}

/** Search hits as memory lines, best first: `YYYY-MM-DD: Entity — predicate: object`. */
function memoryLinesOf(hits: SearchHit[], limit = 60): string[] {
  return hits
    .flatMap((hit) =>
      (hit.facts ?? []).map((f) => ({
        line: `${String(f.validFrom ?? '').slice(0, 10)}: ${hit.canonicalName} — ${f.predicate}: ${f.object}`,
        score: f.score ?? hit.score ?? 0,
      })),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((l) => l.line);
}

interface IngestOutcome {
  entityIds: string[];
  factIds: string[];
  /** Until the write was acknowledged. */
  ackMs: number;
  /** Until it was fully processed (== ackMs in sync mode). */
  settledMs: number;
}

interface Timeline {
  events?: Array<{ factId?: string; predicate?: string; object?: string }>;
}

interface SearchHit {
  canonicalName: string;
  score?: number;
  facts?: Array<{ predicate: string; object: string; validFrom?: string; score?: number }>;
}

// ── models ───────────────────────────────────────────────────────────

// Built on first use: a harness run has no key, and the client refuses to construct without one.
let openai: OpenAI | undefined;
const client = (): OpenAI =>
  (openai ??= new OpenAI({
    ...(process.env.HALUMEM_OPENAI_BASE_URL
      ? { baseURL: process.env.HALUMEM_OPENAI_BASE_URL }
      : {}),
  }));

/** One completion as the toolkit sends it: a single user message, temperature 0. */
async function complete(model: string, prompt: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await client().chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      return r.choices[0]?.message?.content ?? '';
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
}

/**
 * Harness mode: the prompts the connected agent has still to answer, and
 * the replies it has given (one JSON object per line: `{ id, reply }`).
 */
class AgentExchange {
  readonly missing: Array<{ id: string; prompt: string }> = [];
  private readonly replies = new Map<string, string>();

  constructor(
    readonly requestsPath: string,
    readonly repliesPath: string,
  ) {
    if (!existsSync(repliesPath)) return;
    for (const line of readFileSync(repliesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { id: string; reply: string };
      this.replies.set(r.id, r.reply);
    }
  }

  reply(id: string, prompt: string): string | undefined {
    const r = this.replies.get(id);
    if (r === undefined) this.missing.push({ id, prompt });
    return r;
  }

  /** Write what is still unanswered; true when the run has to stop for the agent. */
  flush(what: string): boolean {
    if (this.missing.length === 0) return false;
    writeFileSync(this.requestsPath, this.missing.map((m) => JSON.stringify(m)).join('\n') + '\n');
    console.log(
      `[halumem] ${this.missing.length} ${what} for the agent: ${this.requestsPath}\n` +
        `          reply as {"id","reply"} lines in ${this.repliesPath}, then run again`,
    );
    return true;
  }
}

function exchangeFor(cfg: Config, kind: 'answers' | 'judge'): AgentExchange | undefined {
  if (cfg.model !== 'harness') return undefined;
  const base = join(cfg.reportDir, `halumem-${cfg.runId}-${kind}`);
  return new AgentExchange(`${base}-requests.jsonl`, `${base}.jsonl`);
}

/** A judge call; null when the model's output never parsed (the toolkit's `None`). */
async function judge(
  cfg: Config,
  prompt: string,
  id: string,
  agent?: AgentExchange,
): Promise<Record<string, unknown> | null> {
  if (agent) {
    const reply = agent.reply(id, prompt);
    if (reply === undefined) return null;
    try {
      return judgeJson(reply);
    } catch {
      return null;
    }
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return judgeJson(await complete(cfg.judgeModel, prompt));
    } catch {
      // the toolkit retries the whole request, parse included
    }
  }
  return null;
}

// ── phase 1: the system ──────────────────────────────────────────────

async function runUser(
  cfg: Config,
  brain: Brain,
  prompts: HaluMemPrompts,
  user: HaluMemUser,
): Promise<SystemUser> {
  const userName = userNameOf(user.persona_info);
  const userId = `halumem-${user.uuid}`;
  const out: SystemUser = { uuid: user.uuid, user_name: userName, sessions: [] };
  for (const [i, session] of user.sessions.entries()) {
    const doc = await brain.ingestSession({
      kind: 'chat',
      title: `HaluMem ${userName} session ${i + 1}`,
      text: sessionTranscript(session, userName),
      occurredAt: haluMemTime(session.start_time),
      userId,
      contextRef: { vertical: 'halumem', conversationId: `${cfg.runId}-${user.uuid}-s${i}` },
    });
    const add_duration_ms = doc.settledMs;
    const tag = `[${userName} ${i + 1}/${user.sessions.length}]`;
    if (session.is_generated_qa_session) {
      console.log(`${tag} qa-only session written (${add_duration_ms} ms)`);
      continue;
    }
    const extracted = await brain.committedLines(doc.entityIds, doc.factIds, userId);

    const points: SystemSession['memory_points'] = [];
    for (const p of session.memory_points) {
      if (p.is_update === 'True' && p.original_memories.length > 0) {
        points.push({
          ...p,
          memories_from_system: await brain.memoryLines(p.memory_content, userId, 10),
        });
      } else points.push(p);
    }

    const questions: SystemQuestion[] = [];
    for (const q of session.questions ?? []) {
      if (cfg.model === 'harness') {
        const r = await brain.mcpSynthesize(q.question, userId);
        const full = r.answer === null ? await brain.mcpSynthesize(q.question, userId, 'full') : r;
        questions.push(
          r.answer !== null
            ? { ...q, system_response: r.answer }
            : {
                ...q,
                system_response: '',
                context: r.evidence ?? '',
                context_full: memoryLinesOf(full.results ?? []).join('\n'),
                pending: true,
              },
        );
        continue;
      }
      const r = await brain.call<{ answer: string | null }>('POST', '/v1/synthesize', {
        query: q.question,
        userId,
      });
      questions.push({ ...q, system_response: r.answer ?? "I don't know." });
    }
    out.sessions.push({
      dialogue_for_judge: judgeDialogue(session),
      memory_points: points,
      extracted_memories: extracted,
      questions,
      add_duration_ms,
      ack_ms: doc.ackMs,
    });
    console.log(
      `${tag} ${extracted.length} memories, ${points.filter((p) => p.memories_from_system).length} updates, ${questions.length} answers (${add_duration_ms} ms add)`,
    );
  }
  return out;
}

// ── phase 2: the judge ───────────────────────────────────────────────

interface Judged {
  integrity: IntegrityRecord[];
  accuracy: AccuracyRecord[];
  updates: UpdateRecord[];
  qa: QaRecord[];
}

async function judgeAll(
  cfg: Config,
  prompts: HaluMemPrompts,
  users: SystemUser[],
  agent?: AgentExchange,
): Promise<Judged> {
  const out: Judged = {
    integrity: [],
    accuracy: [],
    updates: [],
    qa: [],
  };
  const jobs: Array<() => Promise<void>> = [];
  for (const [ui, u] of users.entries()) {
    for (const [si, s] of u.sessions.entries()) {
      const at = `${ui}:${si}`;
      const extractedStr = s.extracted_memories.join('\n');
      const golden = s.memory_points
        .filter((p) => p.memory_source !== 'interference')
        .map((p) => p.memory_content)
        .join('\n');
      for (const [pi, p] of s.memory_points.entries()) {
        if (p.is_update === 'True' && p.memories_from_system?.length) {
          jobs.push(async () => {
            const r = await judge(
              cfg,
              pyFormat(prompts.updateMemory, {
                memories: p.memories_from_system!.join('\n'),
                updated_memory: p.memory_content,
                original_memory: p.original_memories.join('\n'),
              }),
              `upd:${at}:${pi}`,
              agent,
            );
            out.updates.push({ memoryType: p.memory_type, verdict: str(r?.evaluation_result) });
          });
          continue;
        }
        const base = {
          memorySource: p.memory_source,
          memoryType: p.memory_type,
          importance: p.importance,
        };
        if (!extractedStr.trim()) {
          out.integrity.push({ ...base, score: 0 });
          continue;
        }
        jobs.push(async () => {
          const r = await judge(
            cfg,
            pyFormat(prompts.memoryIntegrity, {
              memories: extractedStr,
              expected_memory_point: p.memory_content,
            }),
            `int:${at}:${pi}`,
            agent,
          );
          out.integrity.push({ ...base, score: num(r?.score) });
        });
      }
      for (const [mi, m] of s.extracted_memories.entries()) {
        jobs.push(async () => {
          const r = await judge(
            cfg,
            pyFormat(prompts.memoryAccuracy, {
              dialogue: s.dialogue_for_judge,
              golden_memories: golden,
              candidate_memory: m,
            }),
            `acc:${at}:${mi}`,
            agent,
          );
          out.accuracy.push({
            includedInGolden: ['true', 'True'].includes(String(r?.is_included_in_golden_memories)),
            score: num(r?.accuracy_score),
          });
        });
      }
      for (const [qi, q] of s.questions.entries()) {
        if (q.arm === 'protocol') continue;
        jobs.push(async () => {
          const r = await judge(
            cfg,
            pyFormat(prompts.question, {
              question: q.question,
              reference_answer: q.answer,
              key_memory_points: q.evidence.map((e) => e.memory_content).join('\n'),
              response: q.system_response,
            }),
            `qa:${at}:${qi}`,
            agent,
          );
          out.qa.push({ questionType: q.question_type, verdict: str(r?.evaluation_result) });
        });
      }
    }
  }
  let done = 0;
  await runPool(cfg.judgeConcurrency, jobs, async (job) => {
    await job();
    if (++done % 50 === 0) console.log(`[judge] ${done}/${jobs.length}`);
  });
  return out;
}

/**
 * Harness mode: the agent's answers to the questions brain left
 * unanswered, through the toolkit's answer prompt over brain's evidence.
 */
function fillAnswers(system: SystemUser[], prompts: HaluMemPrompts, agent: AgentExchange): void {
  for (const [ui, u] of system.entries()) {
    for (const [si, s] of u.sessions.entries()) {
      for (const [qi, q] of s.questions.entries()) {
        if (!q.pending) continue;
        const reply = agent.reply(
          `ans:${ui}:${si}:${qi}`,
          pyFormat(prompts.answer, { context: q.context ?? '', question: q.question }),
        );
        if (reply === undefined) continue;
        // EXPAND: the agent followed the "(+N more …)" hint; it answers again
        // from the full read taken at the same moment.
        if (reply.trim() === 'EXPAND' && q.context_full) {
          const again = agent.reply(
            `ans2:${ui}:${si}:${qi}`,
            pyFormat(prompts.answer, { context: q.context_full, question: q.question }),
          );
          if (again !== undefined) q.system_response = again.trim();
        } else q.system_response = reply.trim();
      }
    }
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const prompts = loadHaluMemPrompts(cfg.repo);
  mkdirSync(cfg.reportDir, { recursive: true });
  const systemPath = cfg.systemFile ?? join(cfg.reportDir, `halumem-system-${cfg.runId}.jsonl`);

  if (!cfg.systemFile) {
    const users = loadHaluMem(cfg.data, { users: cfg.users, sessions: cfg.sessions });
    const done = await loadCheckpoint<SystemUser>(systemPath, (u) => u.uuid);
    const brain = new Brain(cfg);
    console.log(
      `[halumem] run ${cfg.runId}: ${users.length} users × ≤${cfg.sessions || 'all'} sessions, ${done.size} already done`,
    );
    await runPool(cfg.concurrency, users, async (u) => {
      if (done.has(u.uuid)) return;
      const r = await runUser(cfg, brain, prompts, u);
      await appendCheckpoint(systemPath, r);
    });
  }

  const system = readFileSync(systemPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SystemUser);
  const answers = exchangeFor(cfg, 'answers');
  if (answers) {
    fillAnswers(system, prompts, answers);
    if (answers.flush('answers')) process.exit(3);
  }
  const verdicts = exchangeFor(cfg, 'judge');
  const j = await judgeAll(cfg, prompts, system, verdicts);
  if (verdicts?.flush('judge verdicts')) process.exit(3);
  const integrity = scoreIntegrity(j.integrity);
  const accuracy = scoreAccuracy(j.accuracy);
  const report = {
    runId: cfg.runId,
    judgeModel: cfg.model === 'harness' ? 'harness (connected agent)' : cfg.judgeModel,
    slice: { users: system.length, sessions: system.reduce((n, u) => n + u.sessions.length, 0) },
    ingest: {
      mode: cfg.ingest,
      ack_ms_median: median(
        system.flatMap((u) => u.sessions.map((x) => x.ack_ms ?? x.add_duration_ms)),
      ),
      settled_ms_median: median(system.flatMap((u) => u.sessions.map((x) => x.add_duration_ms))),
    },
    memory_extraction: {
      memory_integrity: integrity,
      memory_accuracy: accuracy,
      memory_extraction_f1: f1(accuracy['target_accuracy(all)'], integrity['recall(all)']),
    },
    memory_update: scoreUpdates(j.updates),
    question_answering: { overall: scoreQa(j.qa), by_type: scoreQaByType(j.qa) },
  };
  const reportPath = join(cfg.reportDir, `halumem-${cfg.runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printScorecard(report);
  console.log(`report: ${reportPath}\nsystem: ${systemPath}`);
}

function printScorecard(r: {
  slice: { users: number; sessions: number };
  ingest: { mode: string; ack_ms_median: number | null; settled_ms_median: number | null };
  memory_extraction: {
    memory_integrity: ReturnType<typeof scoreIntegrity>;
    memory_accuracy: ReturnType<typeof scoreAccuracy>;
    memory_extraction_f1: number | null;
  };
  memory_update: ReturnType<typeof scoreUpdates>;
  question_answering: { overall: ReturnType<typeof scoreQa> };
}): void {
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`;
  const e = r.memory_extraction;
  console.log(`\nHaluMem scorecard — ${r.slice.users} users, ${r.slice.sessions} sessions`);
  console.log('─'.repeat(72));
  console.log(
    `ingest      ${r.ingest.mode}: ack ${r.ingest.ack_ms_median ?? '—'} ms, processed ${r.ingest.settled_ms_median ?? '—'} ms (median per session)`,
  );
  console.log(
    `extraction  recall ${pct(e.memory_integrity['recall(all)'])}  weighted recall ${pct(e.memory_integrity['weighted_recall(all)'])}`,
  );
  console.log(
    `            target precision ${pct(e.memory_accuracy['target_accuracy(all)'])}  weighted precision ${pct(e.memory_accuracy['weighted_accuracy(all)'])}  F1 ${pct(e.memory_extraction_f1)}`,
  );
  console.log(
    `            interference rejected ${pct(e.memory_integrity['interference_accuracy(all)'])}`,
  );
  const u = r.memory_update;
  console.log(
    `update      correct ${pct(u['correct_ratio(all)'])}  hallucination ${pct(u['hallucination_ratio(all)'])}  omission ${pct(u['omission_ratio(all)'])}  (n=${u.num})`,
  );
  const q = r.question_answering;
  console.log(
    `QA          correct ${pct(q.overall['correct_ratio(all)'])}  hallucination ${pct(q.overall['hallucination_ratio(all)'])}  omission ${pct(q.overall['omission_ratio(all)'])}  (n=${q.overall.num})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
