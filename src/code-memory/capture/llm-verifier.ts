import type { ChatComplete } from './llm-extractor';
import type { CommitInput, DecisionCandidate } from './types';

/**
 * Code-memory track C — teacher verification (LLM-as-judge).
 * (docs/code-memory/distillation-dataset.md)
 *
 * The Layer-2 extractor is a lenient teacher: the first real run showed it
 * manufactures a `decided` from a bare "what" subject, so ~97% of diverse
 * commits came back positive — teacher PRECISION was the bottleneck. This adds a
 * second, STRICT pass: a judge re-scores each candidate ("is this a genuine,
 * non-derivable engineering why, or a restatement of the change?"), dropping the
 * false ones and calibrating confidence. Extractor + verifier = a stronger
 * teacher; it composes with the confidence gate (`--min-confidence`) since it
 * writes the confidence the gate thresholds on.
 *
 * Behind the same {@link ChatComplete} seam as the extractor, so it's stubbable.
 * Fail-OPEN: a judge error or unparseable response keeps the raw candidates
 * (verification must never silently delete a real "why").
 */

export interface DecisionVerifier {
  /** Return the kept candidates (dropped = judged false), confidence calibrated. */
  rescore(
    commit: CommitInput,
    candidates: DecisionCandidate[],
  ): Promise<DecisionCandidate[]>;
}

export class LlmDecisionVerifier implements DecisionVerifier {
  constructor(private readonly complete: ChatComplete) {}

  async rescore(
    commit: CommitInput,
    candidates: DecisionCandidate[],
  ): Promise<DecisionCandidate[]> {
    if (candidates.length === 0) return [];
    const raw = await this.complete(buildVerifyPrompt(commit, candidates));
    return applyVerdicts(candidates, raw);
  }
}

export function buildVerifyPrompt(
  commit: CommitInput,
  candidates: DecisionCandidate[],
): { system: string; user: string } {
  const system = `You are a STRICT reviewer of engineering-knowledge extractions. For each item, decide whether it is a GENUINE, non-derivable engineering "why" that is EXPLICITLY stated in the commit — a real design decision, rationale, invariant, or gotcha — and NOT a mere restatement of what the code change literally does.

Reject (keep=false) an item that just paraphrases the change ("decided to add X" for a commit whose subject is "Add X"), states no reason/constraint/trap, or is not supported by the text. Keep (keep=true) only items a parser could not recover from the diff.

Return STRICT JSON: {"verdicts":[{"keep":true,"confidence":0.0}]} — EXACTLY one entry per item, in the SAME ORDER. confidence is 0..1, your certainty the item is a genuine "why".`;

  const body = commit.prBody
    ? `${commit.message}\n\nPR body:\n${commit.prBody}`
    : commit.message;
  const items = candidates
    .map((c, i) => `${i}. [${c.kind}] ${c.text}`)
    .join('\n');
  const user = `Commit:\n${body}\n\nItems to review:\n${items}`;
  return { system, user };
}

/** Apply the judge's verdicts to the candidates. Drops keep=false; calibrates
 *  confidence from the verdict. Fail-open: on any mismatch/parse failure the
 *  original candidates are returned unchanged. */
export function applyVerdicts(
  candidates: DecisionCandidate[],
  raw: string,
): DecisionCandidate[] {
  const verdicts = parseVerdicts(raw);
  // A judge that returned the wrong count is untrustworthy for alignment —
  // keep the raw candidates rather than drop by a misaligned index.
  if (!verdicts || verdicts.length !== candidates.length) return candidates;
  const out: DecisionCandidate[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const v = verdicts[i]!; // verdicts.length === candidates.length (checked)
    if (v.keep === false) continue;
    const confidence =
      typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1
        ? v.confidence
        : candidate.confidence;
    out.push({ ...candidate, confidence });
  }
  return out;
}

function parseVerdicts(
  raw: string,
): Array<{ keep?: boolean | undefined; confidence?: number | undefined }> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { verdicts?: unknown[] })?.verdicts)
      ? (parsed as { verdicts: unknown[] }).verdicts
      : null;
  if (!list) return null;
  return list.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      keep: typeof o.keep === 'boolean' ? o.keep : undefined,
      confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    };
  });
}
