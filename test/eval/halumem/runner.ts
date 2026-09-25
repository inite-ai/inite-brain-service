/**
 * HaluMem runner — operation-level hallucination evaluation of brain as an
 * agent memory (arXiv 2511.03506; toolkit github.com/MemTensor/HaluMem).
 *
 * Phase 1 (the system) drives a booted stand over the wire, user by user,
 * session by session, in order — the protocol of the toolkit's adapters:
 *  - add:      each session is ONE chat document (POST /v1/ingest/document,
 *              the user's own scope); what it committed is the session's
 *              extracted memory, rendered `Entity — predicate: object`;
 *  - update:   for every gold point that updates an earlier one, the
 *              top-10 memories a search for it returns;
 *  - QA:       every question, answered two ways —
 *                protocol: search (top-K) → the toolkit's answer prompt →
 *                          the answer model (the adapters' own recipe);
 *                synthesize: brain's own answer (abstention = "I don't know").
 * Phase 2 (the judge) runs the toolkit's four judge prompts, verbatim, on
 * the judge model, and aggregates exactly as evaluation.py does.
 *
 * Phase 1 checkpoints per user (HALUMEM_RUN_ID) and a finished system file
 * can be judged again alone (HALUMEM_SYSTEM_FILE). Never run in CI.
 *
 * Run: pnpm eval:halumem   (README.md lists the env)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  topK: number;
  concurrency: number;
  judgeConcurrency: number;
  judgeModel: string;
  answerModel: string;
  runId: string;
  reportDir: string;
  systemFile: string | undefined;
  arms: Arm[];
}

type Arm = 'protocol' | 'synthesize';

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
    topK: intEnv('HALUMEM_TOP_K', 20),
    concurrency: intEnv('HALUMEM_CONCURRENCY', 2),
    judgeConcurrency: intEnv('HALUMEM_JUDGE_CONCURRENCY', 8),
    judgeModel: process.env.HALUMEM_JUDGE_MODEL ?? 'gpt-4o',
    answerModel: process.env.HALUMEM_ANSWER_MODEL ?? 'gpt-4o',
    runId: process.env.HALUMEM_RUN_ID ?? `hm${Date.now().toString(36)}`,
    reportDir: process.env.HALUMEM_REPORT_DIR ?? 'var/halumem',
    systemFile,
    arms: (process.env.HALUMEM_ARMS ?? 'protocol,synthesize')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Arm => s === 'protocol' || s === 'synthesize'),
  };
}

// ── the system's output (phase 1), in the toolkit's shape ────────────

interface SystemQuestion extends HaluMemQuestion {
  arm: Arm;
  system_response: string;
  context?: string;
}

interface SystemSession {
  dialogue_for_judge: string;
  memory_points: Array<HaluMemPoint & { memories_from_system?: string[] }>;
  extracted_memories: string[];
  questions: SystemQuestion[];
  add_duration_ms: number;
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

interface Timeline {
  events?: Array<{ factId?: string; predicate?: string; object?: string }>;
}

interface SearchHit {
  canonicalName: string;
  score?: number;
  facts?: Array<{ predicate: string; object: string; validFrom?: string; score?: number }>;
}

// ── models ───────────────────────────────────────────────────────────

const openai = new OpenAI({
  ...(process.env.HALUMEM_OPENAI_BASE_URL ? { baseURL: process.env.HALUMEM_OPENAI_BASE_URL } : {}),
});

/** One completion as the toolkit sends it: a single user message, temperature 0. */
async function complete(model: string, prompt: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await openai.chat.completions.create({
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

/** A judge call; null when the model's output never parsed (the toolkit's `None`). */
async function judge(cfg: Config, prompt: string): Promise<Record<string, unknown> | null> {
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

/** The Mem0 adapter's context template (eval_memzero.py TEMPLATE_MEM0). */
function mem0Context(userName: string, lines: string[]): string {
  return `Memories for user ${userName}:\n\n    ${JSON.stringify(lines, null, 4)}\n`;
}

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
    const started = Date.now();
    const doc = await brain.call<{ committed: { entityIds: string[]; factIds: string[] } }>(
      'POST',
      '/v1/ingest/document',
      {
        kind: 'chat',
        title: `HaluMem ${userName} session ${i + 1}`,
        text: sessionTranscript(session, userName),
        occurredAt: haluMemTime(session.start_time),
        userId,
        contextRef: { vertical: 'halumem', conversationId: `${cfg.runId}-${user.uuid}-s${i}` },
      },
    );
    const add_duration_ms = Date.now() - started;
    const tag = `[${userName} ${i + 1}/${user.sessions.length}]`;
    if (session.is_generated_qa_session) {
      console.log(`${tag} qa-only session written (${add_duration_ms} ms)`);
      continue;
    }
    const extracted = await brain.committedLines(
      doc.committed.entityIds,
      doc.committed.factIds,
      userId,
    );

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
      if (cfg.arms.includes('protocol')) {
        const context = mem0Context(
          userName,
          await brain.memoryLines(q.question, userId, cfg.topK),
        );
        const response = await complete(
          cfg.answerModel,
          pyFormat(prompts.answer, { context, question: q.question }),
        );
        questions.push({ ...q, arm: 'protocol', system_response: response, context });
      }
      if (cfg.arms.includes('synthesize')) {
        const r = await brain.call<{ answer: string | null }>('POST', '/v1/synthesize', {
          query: q.question,
          userId,
        });
        questions.push({ ...q, arm: 'synthesize', system_response: r.answer ?? "I don't know." });
      }
    }
    out.sessions.push({
      dialogue_for_judge: judgeDialogue(session),
      memory_points: points,
      extracted_memories: extracted,
      questions,
      add_duration_ms,
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
  qa: Record<Arm, QaRecord[]>;
}

async function judgeAll(
  cfg: Config,
  prompts: HaluMemPrompts,
  users: SystemUser[],
): Promise<Judged> {
  const out: Judged = {
    integrity: [],
    accuracy: [],
    updates: [],
    qa: { protocol: [], synthesize: [] },
  };
  const jobs: Array<() => Promise<void>> = [];
  for (const u of users) {
    for (const s of u.sessions) {
      const extractedStr = s.extracted_memories.join('\n');
      const golden = s.memory_points
        .filter((p) => p.memory_source !== 'interference')
        .map((p) => p.memory_content)
        .join('\n');
      for (const p of s.memory_points) {
        if (p.is_update === 'True' && p.memories_from_system?.length) {
          jobs.push(async () => {
            const r = await judge(
              cfg,
              pyFormat(prompts.updateMemory, {
                memories: p.memories_from_system!.join('\n'),
                updated_memory: p.memory_content,
                original_memory: p.original_memories.join('\n'),
              }),
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
          );
          out.integrity.push({ ...base, score: num(r?.score) });
        });
      }
      for (const m of s.extracted_memories) {
        jobs.push(async () => {
          const r = await judge(
            cfg,
            pyFormat(prompts.memoryAccuracy, {
              dialogue: s.dialogue_for_judge,
              golden_memories: golden,
              candidate_memory: m,
            }),
          );
          out.accuracy.push({
            includedInGolden: ['true', 'True'].includes(String(r?.is_included_in_golden_memories)),
            score: num(r?.accuracy_score),
          });
        });
      }
      for (const q of s.questions) {
        jobs.push(async () => {
          const r = await judge(
            cfg,
            pyFormat(prompts.question, {
              question: q.question,
              reference_answer: q.answer,
              key_memory_points: q.evidence.map((e) => e.memory_content).join('\n'),
              response: q.system_response,
            }),
          );
          out.qa[q.arm].push({ questionType: q.question_type, verdict: str(r?.evaluation_result) });
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
      `[halumem] run ${cfg.runId}: ${users.length} users × ≤${cfg.sessions || 'all'} sessions, arms ${cfg.arms.join('+')}, ${done.size} already done`,
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
  const j = await judgeAll(cfg, prompts, system);
  const integrity = scoreIntegrity(j.integrity);
  const accuracy = scoreAccuracy(j.accuracy);
  const report = {
    runId: cfg.runId,
    judgeModel: cfg.judgeModel,
    answerModel: cfg.answerModel,
    slice: { users: system.length, sessions: system.reduce((n, u) => n + u.sessions.length, 0) },
    memory_extraction: {
      memory_integrity: integrity,
      memory_accuracy: accuracy,
      memory_extraction_f1: f1(accuracy['target_accuracy(all)'], integrity['recall(all)']),
    },
    memory_update: scoreUpdates(j.updates),
    question_answering: Object.fromEntries(
      cfg.arms.map((a) => [a, { overall: scoreQa(j.qa[a]), by_type: scoreQaByType(j.qa[a]) }]),
    ),
  };
  const reportPath = join(cfg.reportDir, `halumem-${cfg.runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printScorecard(report);
  console.log(`report: ${reportPath}\nsystem: ${systemPath}`);
}

function printScorecard(r: {
  slice: { users: number; sessions: number };
  memory_extraction: {
    memory_integrity: ReturnType<typeof scoreIntegrity>;
    memory_accuracy: ReturnType<typeof scoreAccuracy>;
    memory_extraction_f1: number | null;
  };
  memory_update: ReturnType<typeof scoreUpdates>;
  question_answering: Record<string, { overall: ReturnType<typeof scoreQa> }>;
}): void {
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`;
  const e = r.memory_extraction;
  console.log(`\nHaluMem scorecard — ${r.slice.users} users, ${r.slice.sessions} sessions`);
  console.log('─'.repeat(72));
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
  for (const [arm, q] of Object.entries(r.question_answering)) {
    console.log(
      `QA ${arm.padEnd(10)} correct ${pct(q.overall['correct_ratio(all)'])}  hallucination ${pct(q.overall['hallucination_ratio(all)'])}  omission ${pct(q.overall['omission_ratio(all)'])}  (n=${q.overall.num})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
