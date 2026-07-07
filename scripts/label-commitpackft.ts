#!/usr/bin/env tsx
/**
 * Code-memory track C — silver-label an EXTERNAL commit corpus (CommitPackFT).
 * (docs/code-memory/distillation-dataset.md)
 *
 *   OPENAI_API_KEY=... pnpm label:commitpackft -- \
 *     --langs python,javascript,typescript,go,java,c \
 *     --per-lang 100 \
 *     --out data/code-memory/silver-commitpackft.jsonl [--model gpt-4o-mini] [--concurrency 8]
 *
 * A project's own disciplined history is nearly all decision-bearing (see the
 * brain run: 384 pos / 1 neg) — too degenerate to train a gate. CommitPackFT
 * (bigcode/commitpackft, 277 langs) is a diverse corpus: most rows state WHAT
 * changed with no WHY, so the Layer-2 teacher labels them NEGATIVE, giving the
 * real negatives a binary gate needs. Pulled row-by-row via the HF
 * datasets-server API — no full-dataset download. Same teacher + heuristic +
 * SilverExample schema as `pnpm label:decisions`, so outputs concat directly.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import {
  LlmDecisionExtractor,
  makeOpenAiCompleter,
} from '../src/code-memory/capture/llm-extractor';
import { labelCommits } from '../src/code-memory/capture/silver-dataset';
import type { CommitInput } from '../src/code-memory/capture/types';

const HF = 'https://datasets-server.huggingface.co';
const DATASET = 'bigcode/commitpackft';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface CpftRow {
  commit?: string;
  message?: string;
  subject?: string;
  new_file?: string;
  old_file?: string;
}

async function fetchLang(lang: string, perLang: number): Promise<CommitInput[]> {
  const out: CommitInput[] = [];
  for (let offset = 0; out.length < perLang; offset += 100) {
    const length = Math.min(100, perLang - out.length);
    const url = `${HF}/rows?dataset=${DATASET}&config=${lang}&split=train&offset=${offset}&length=${length}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[cpft] ${lang} offset ${offset}: ${res.status}, stopping this lang`);
      break;
    }
    const body = (await res.json()) as { rows?: Array<{ row: CpftRow }> };
    const rows = body.rows ?? [];
    if (rows.length === 0) break;
    for (const { row } of rows) {
      const message = (row.message ?? row.subject ?? '').trim();
      const file = row.new_file || row.old_file;
      if (!message || !file) continue;
      out.push({
        sha: row.commit ?? `cpft_${lang}_${offset}_${out.length}`,
        message,
        changedFiles: [file],
        authorDate: '2020-01-01T00:00:00Z',
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const langs = arg('langs', 'python,javascript,typescript,go,java,c')!
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  const perLang = parseInt(arg('per-lang', '100')!, 10);
  const out = arg('out', 'data/code-memory/silver-commitpackft.jsonl')!;
  const model = arg('model', process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini')!;
  const concurrency = parseInt(arg('concurrency', '8')!, 10);
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

  const commits: CommitInput[] = [];
  for (const lang of langs) {
    const c = await fetchLang(lang, perLang);
    console.error(`[cpft] ${lang}: ${c.length} rows`);
    commits.push(...c);
  }
  console.error(`[cpft] ${commits.length} commit(s) → ${out} (teacher=${model})`);

  mkdirSync(dirname(out), { recursive: true });
  const stream = createWriteStream(out, { flags: 'w' });
  const summary = await labelCommits({
    commits,
    extractor: new LlmDecisionExtractor(
      makeOpenAiCompleter({ apiKey: process.env.OPENAI_API_KEY, model }),
    ),
    classifier: new HeuristicDecisionClassifier(),
    emit: (ex) => stream.write(`${JSON.stringify(ex)}\n`),
    concurrency,
    log: (m) => console.error(`[cpft] ${m}`),
  });
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  console.error(`[cpft] done: ${JSON.stringify(summary)}`);
}

main().catch((e) => {
  console.error(`[cpft] fatal: ${(e as Error).message}`);
  process.exit(1);
});
