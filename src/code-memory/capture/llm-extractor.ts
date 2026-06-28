import OpenAI from 'openai';
import type {
  CommitInput,
  DecisionCandidate,
  DecisionExtractor,
  DecisionKind,
} from './types';

/**
 * Layer 2 — LLM extraction of the Decision/Rationale taxonomy from a commit's
 * NON-CODE signal (message + PR body + changed file PATHS). File contents are
 * never sent — Phase 1 anchors at file granularity, which also keeps the hybrid
 * client-side privacy contract tight (only paths + prose leave the machine, and
 * only to the caller's own LLM).
 *
 * The LLM call sits behind {@link ChatComplete} so prompt-building and parsing
 * are unit-tested with a stub; `makeOpenAiCompleter` is the default impl.
 * Extraction is GROUNDED: a candidate whose anchor is not one of the commit's
 * changed files is re-anchored to the sole changed file or dropped — the model
 * cannot invent a path.
 */

export type ChatComplete = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

const KINDS: DecisionKind[] = ['decided', 'because', 'invariant', 'gotcha'];

export class LlmDecisionExtractor implements DecisionExtractor {
  constructor(private readonly complete: ChatComplete) {}

  async extract(commit: CommitInput): Promise<DecisionCandidate[]> {
    const raw = await this.complete(buildExtractionPrompt(commit));
    return parseCandidates(raw, commit);
  }
}

export function buildExtractionPrompt(commit: CommitInput): {
  system: string;
  user: string;
} {
  const system = `You extract the non-derivable engineering "why" from a git commit — knowledge a parser cannot recover from source. Output ONLY decisions, rationale, invariants, and gotchas that are EXPLICITLY present in the message or PR body. Never restate what the code change literally is; capture the reasoning behind it. If the commit carries no such "why", return an empty list.

Return STRICT JSON: {"decisions":[{"kind","text","anchor","confidence"}]}.
- kind: one of decided | because | invariant | gotcha
- text: the decision/rationale/invariant/gotcha, one sentence, faithful to the commit
- anchor: the MOST relevant changed file path, chosen verbatim from the provided list
- confidence: 0..1, how explicitly the commit states it`;

  const files = commit.changedFiles.map((f) => `- ${f}`).join('\n');
  const user = `Commit ${commit.sha}
Message:
${commit.message}
${commit.prBody ? `\nPR body:\n${commit.prBody}\n` : ''}
Changed files (choose anchors only from these):
${files}`;

  return { system, user };
}

export function parseCandidates(
  raw: string,
  commit: CommitInput,
): DecisionCandidate[] {
  const parsed = safeParse(raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { decisions?: unknown[] })?.decisions)
      ? (parsed as { decisions: unknown[] }).decisions
      : [];
  const changed = new Set(commit.changedFiles);
  const out: DecisionCandidate[] = [];
  for (const item of list) {
    const o = item as Record<string, unknown>;
    const kind = o.kind as DecisionKind;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!KINDS.includes(kind) || !text) continue;
    // Ground the anchor: must be one of the commit's changed files. If the
    // model picked something else, fall back to the sole changed file, else drop.
    let anchor = typeof o.anchor === 'string' ? o.anchor : '';
    if (!changed.has(anchor)) {
      if (commit.changedFiles.length === 1) anchor = commit.changedFiles[0];
      else continue;
    }
    const confidence =
      typeof o.confidence === 'number' &&
      o.confidence >= 0 &&
      o.confidence <= 1
        ? o.confidence
        : undefined;
    out.push({
      kind,
      text,
      anchor,
      commit: commit.sha,
      validFrom: commit.authorDate,
      confidence,
    });
  }
  return out;
}

function safeParse(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(body.slice(start));
  } catch {
    return null;
  }
}

/**
 * Default {@link ChatComplete} backed by OpenAI. Runs client-side (the caller's
 * own key), so the brain server never sees the commit text. JSON-object response
 * format; temperature 0 for stable extraction.
 */
export function makeOpenAiCompleter(opts: {
  apiKey: string;
  model?: string;
}): ChatComplete {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? 'gpt-4o-mini';
  return async ({ system, user }) => {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_completion_tokens: 800,
    });
    return res.choices[0]?.message?.content ?? '';
  };
}
