#!/usr/bin/env node
/**
 * brain lifecycle hooks for Claude Code.
 *
 *   recall   — SessionStart: ask brain what it knows about this project
 *              and hand it back as additionalContext.
 *   capture  — PreCompact / SessionEnd: send what the human asked for
 *              into brain so the next session starts informed.
 *
 * Why this exists: an MCP tool surface only remembers when the model
 * chooses to call it, and models mostly don't call `record_fact`
 * unprompted. Lifecycle hooks are what turn "the agent CAN remember"
 * into "the agent DOES remember" — the single biggest reason memory
 * integrations feel dead in practice.
 *
 * Discipline, throughout: never throw, never block, never print
 * anything on the failure path. A memory layer that can break a coding
 * session is worse than no memory layer.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/** Hard ceilings — the mention DTO caps at 16 000 chars server-side. */
const MAX_CAPTURE_CHARS = 6000;
/**
 * Floor for "worth a write". Set to skip acknowledgements — "ok", "yes",
 * "continue", "go on" — while still capturing a one-line instruction,
 * which is often the most valuable thing in a session.
 */
const MIN_CAPTURE_CHARS = 40;
const MAX_RECALL_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 12_000;

const config = () => ({
  apiKey: process.env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '',
  baseUrl: (process.env.CLAUDE_PLUGIN_OPTION_BASE_URL || 'https://brain.inite.ai').replace(
    /\/+$/,
    '',
  ),
  userId: process.env.CLAUDE_PLUGIN_OPTION_USER_ID || '',
  recallOn: process.env.CLAUDE_PLUGIN_OPTION_RECALL_ON_START !== 'false',
  captureOn: process.env.CLAUDE_PLUGIN_OPTION_CAPTURE_SESSIONS !== 'false',
});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function api(path, body, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What to call this project in memory. The git remote is the stable
 * name — two clones of the same repo in different directories are one
 * project — with the directory name as the fallback.
 */
async function projectName(cwd) {
  try {
    const head = await readFile(join(cwd, '.git', 'config'), 'utf8');
    const match = head.match(/url\s*=\s*.*?([^/:]+\/[^/\s]+?)(?:\.git)?\s*$/m);
    if (match) return match[1];
  } catch {
    /* not a git repo, or unreadable — fall through */
  }
  return basename(cwd || process.cwd());
}

// ── recall ───────────────────────────────────────────────────────────

function renderRecall(results) {
  const lines = [];
  for (const hit of results) {
    const facts = (hit.facts ?? [])
      .slice(0, 4)
      .map((f) => `${f.predicate} ${f.object}`)
      .join('; ');
    if (!facts) continue;
    lines.push(`- ${hit.canonicalName}: ${facts}`);
    if (lines.join('\n').length > MAX_RECALL_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_RECALL_CHARS);
}

async function recall(payload, cfg) {
  if (!cfg.recallOn) return;
  const project = await projectName(payload.cwd ?? process.cwd());
  const body = { query: project, limit: 8 };
  if (cfg.userId) body.userId = cfg.userId;
  const out = await api('/v1/search', body, cfg);
  const rendered = renderRecall(out?.results ?? []);
  if (!rendered) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          `What brain remembers about ${project} (ask it directly with the brain MCP tools for more):`,
          rendered,
        ].join('\n'),
      },
    }),
  );
}

// ── capture ──────────────────────────────────────────────────────────

/** Plain text of one transcript entry, or '' for anything else. */
function userText(entry) {
  if (entry?.type !== 'user') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // tool_result blocks are the agent talking to itself — skip them.
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The human's own messages, in order. Deliberately NOT the assistant's:
 * feeding a model's output back in as remembered fact is how memory
 * layers poison themselves, and the intent — what was asked for and why
 * — lives on the human side anyway.
 */
async function humanTurns(transcriptPath) {
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userText(entry).trim();
    // Slash commands and local-command stdout are harness plumbing.
    if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) continue;
    turns.push(text);
  }
  return turns;
}

/**
 * PreCompact and SessionEnd both fire for the same session, so capture
 * keeps a per-session watermark: only turns after the last captured one
 * are sent. Lives in tmp because it is worthless after the session ends.
 */
async function watermarkPath(sessionId) {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), 'inite-brain-hooks');
  await mkdir(dir, { recursive: true }).catch(() => {});
  return join(dir, `capture-${(sessionId || 'unknown').replace(/[^\w.-]/g, '_')}.txt`);
}

async function readWatermark(path) {
  try {
    return Number.parseInt(await readFile(path, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

async function capture(payload, cfg) {
  if (!cfg.captureOn) return;
  const turns = await humanTurns(payload.transcript_path ?? '');
  if (turns.length === 0) return;

  const mark = await watermarkPath(payload.session_id);
  const already = await readWatermark(mark);
  const fresh = turns.slice(already);
  if (fresh.length === 0) return;

  // Newest turns matter most, so trim from the front when over budget.
  let text = fresh.join('\n\n');
  if (text.length > MAX_CAPTURE_CHARS) text = text.slice(-MAX_CAPTURE_CHARS);
  if (text.length < MIN_CAPTURE_CHARS) return;

  const project = await projectName(payload.cwd ?? process.cwd());
  const body = {
    text: `Working session on ${project}. What the user asked for:\n\n${text}`,
    contextRef: {
      vertical: 'chat',
      conversationId: String(payload.session_id ?? ''),
      recorder: 'claude-code',
    },
    emittedAt: new Date().toISOString(),
  };
  if (cfg.userId) body.userId = cfg.userId;

  const out = await api('/v1/ingest/mention', body, cfg);
  // Advance the watermark only on a confirmed write, so a brain that was
  // briefly down is retried at the next hook rather than skipped.
  if (out) await writeFile(mark, String(turns.length), 'utf8').catch(() => {});
}

// ── entry ────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2];
  const cfg = config();
  if (!cfg.apiKey) return;
  const payload = await readStdin();
  if (mode === 'recall') await recall(payload, cfg);
  else if (mode === 'capture') await capture(payload, cfg);
}

main().catch(() => {
  // Silence is the contract: a hook that prints a stack trace into a
  // session is a worse bug than a hook that did nothing.
  process.exitCode = 0;
});
