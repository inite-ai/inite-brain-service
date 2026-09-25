/**
 * The HaluMem evaluation protocol (Chen et al., 2025, arXiv 2511.03506), as
 * the reference toolkit runs it (github.com/MemTensor/HaluMem, eval/).
 *
 * HaluMem is licensed CC BY-NC-ND 4.0, so neither its data nor its judge
 * prompts are copied into this repository: the runner reads the prompts
 * from an operator-supplied checkout of the toolkit at run time
 * (HALUMEM_REPO) and the dataset from a downloaded file (HALUMEM_DATA).
 * That also keeps the judge verbatim — the protocol is theirs, unedited.
 * What lives here is the machinery around it: reading the Python string
 * constants, Python's str.format, the judge's JSON extraction and the
 * metric arithmetic of evaluation.py, re-implemented.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The four judge prompts (eval/eval_tools.py) and the answer prompt (eval/prompts.py). */
export interface HaluMemPrompts {
  memoryIntegrity: string;
  memoryAccuracy: string;
  updateMemory: string;
  question: string;
  /** The Mem0 adapter's answer prompt — the generic one the toolkit's adapters share. */
  answer: string;
}

/**
 * The value of each named module-level `NAME = """…"""` constant in a
 * Python source. Throws when one is missing, so a toolkit that renamed a
 * prompt fails the run instead of judging with nothing.
 */
export function pythonStringConstants(source: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const m = new RegExp(`^${name}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm').exec(source);
    if (!m) throw new Error(`HaluMem toolkit: constant ${name} not found`);
    out[name] = m[1]!;
  }
  return out;
}

/** The prompts, read from a checkout of github.com/MemTensor/HaluMem. */
export function loadHaluMemPrompts(repoDir: string): HaluMemPrompts {
  const tools = pythonStringConstants(
    readFileSync(join(repoDir, 'eval', 'eval_tools.py'), 'utf8'),
    [
      'EVALUATION_PROMPT_FOR_MEMORY_INTEGRITY',
      'EVALUATION_PROMPT_FOR_MEMORY_ACCURACY',
      'EVALUATION_PROMPT_FOR_UPDATE_MEMORY',
      'EVALUATION_PROMPT_FOR_QUESTION',
    ],
  );
  const answer = pythonStringConstants(readFileSync(join(repoDir, 'eval', 'prompts.py'), 'utf8'), [
    'PROMPT_MEMZERO',
  ]);
  return {
    memoryIntegrity: tools.EVALUATION_PROMPT_FOR_MEMORY_INTEGRITY!,
    memoryAccuracy: tools.EVALUATION_PROMPT_FOR_MEMORY_ACCURACY!,
    updateMemory: tools.EVALUATION_PROMPT_FOR_UPDATE_MEMORY!,
    question: tools.EVALUATION_PROMPT_FOR_QUESTION!,
    answer: answer.PROMPT_MEMZERO!,
  };
}

/**
 * Python's `str.format` for the subset the prompts use: `{name}` fields
 * and the `{{` / `}}` escapes. A field with no value throws (KeyError).
 */
export function pyFormat(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, name: string | undefined) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const v = vars[name!];
    if (v === undefined) throw new Error(`pyFormat: no value for {${name}}`);
    return v;
  });
}

/** The judge's verdict: the first fenced ```json block, parsed (llms.py llm_request_for_json). */
export function judgeJson(content: string): Record<string, unknown> {
  const m = /```json\s*(\{[\s\S]*?\})\s*```/.exec(content);
  if (!m) throw new Error(`No JSON block found in model output: ${content.slice(0, 200)}`);
  return JSON.parse(m[1]!.trim()) as Record<string, unknown>;
}

// ── metrics (evaluation.py aggregate_eval_results) ─────────────────────

export interface IntegrityRecord {
  memorySource: string;
  memoryType: string;
  importance: number;
  /** 0 | 1 | 2, null when the judge failed. */
  score: number | null;
}

export interface AccuracyRecord {
  includedInGolden: boolean;
  /** 0 | 1 | 2, null when the judge failed. */
  score: number | null;
}

export type UpdateVerdict = 'Correct' | 'Hallucination' | 'Omission' | 'Other';
export type QaVerdict = 'Correct' | 'Hallucination' | 'Omission';

export interface UpdateRecord {
  memoryType: string;
  verdict: string | null;
}

export interface QaRecord {
  questionType: string;
  verdict: string | null;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Memory integrity (recall over the gold points) and the interference rejection rate. */
export function scoreIntegrity(records: IntegrityRecord[]) {
  const target = records.filter((r) => r.memorySource !== 'interference');
  const interference = records.filter((r) => r.memorySource === 'interference');
  const validTarget = target.filter((r) => r.score !== null);
  const validInterference = interference.filter((r) => r.score !== null);
  const full = validTarget.filter((r) => r.score === 2).length;
  const weighted = validTarget.reduce((s, r) => s + 0.5 * r.score! * r.importance, 0);
  const importance = (rs: IntegrityRecord[]) => rs.reduce((s, r) => s + r.importance, 0);
  return {
    'recall(all)': ratio(full, target.length),
    'recall(valid)': ratio(full, validTarget.length),
    'weighted_recall(all)': ratio(weighted, importance(target)),
    'weighted_recall(valid)': ratio(weighted, importance(validTarget)),
    memory_num: target.length,
    memory_valid_num: validTarget.length,
    'interference_accuracy(all)': ratio(
      validInterference.filter((r) => r.score === 0).length,
      interference.length,
    ),
    interference_memory_num: interference.length,
  };
}

/** Memory accuracy (precision of what the system extracted). */
export function scoreAccuracy(records: AccuracyRecord[]) {
  const target = records.filter((r) => r.includedInGolden);
  const valid = records.filter((r) => r.score !== null);
  const validTarget = target.filter((r) => r.score !== null);
  const half = (rs: AccuracyRecord[]) => rs.reduce((s, r) => s + 0.5 * r.score!, 0);
  return {
    'target_accuracy(all)': ratio(half(validTarget), target.length),
    'target_accuracy(valid)': ratio(half(validTarget), validTarget.length),
    'weighted_accuracy(all)': ratio(half(valid), records.length),
    'weighted_accuracy(valid)': ratio(half(valid), valid.length),
    target_memory_num: target.length,
    memory_num: records.length,
  };
}

function verdictRatios<V extends string>(
  verdicts: Array<string | null>,
  kinds: readonly V[],
): Record<string, number | null> & { num: number; valid_num: number } {
  const valid = verdicts.filter(
    (v): v is V => v !== null && (kinds as readonly string[]).includes(v),
  );
  const out: Record<string, number | null> = {};
  for (const k of kinds) {
    const n = valid.filter((v) => v === k).length;
    out[`${k.toLowerCase()}_ratio(all)`] = ratio(n, verdicts.length);
    out[`${k.toLowerCase()}_ratio(valid)`] = ratio(n, valid.length);
  }
  return { ...out, num: verdicts.length, valid_num: valid.length };
}

export function scoreUpdates(records: UpdateRecord[]) {
  return verdictRatios(
    records.map((r) => r.verdict),
    ['Correct', 'Hallucination', 'Omission', 'Other'] as const,
  );
}

export function scoreQa(records: QaRecord[]) {
  return verdictRatios(
    records.map((r) => r.verdict),
    ['Correct', 'Hallucination', 'Omission'] as const,
  );
}

/** QA broken down by question type — the paper's per-type table. */
export function scoreQaByType(records: QaRecord[]) {
  const byType = new Map<string, QaRecord[]>();
  for (const r of records) byType.set(r.questionType, [...(byType.get(r.questionType) ?? []), r]);
  return Object.fromEntries([...byType].map(([t, rs]) => [t, scoreQa(rs)]));
}
