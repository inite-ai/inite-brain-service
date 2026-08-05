/**
 * LoCoMo FULL-CONTEXT baseline — the honest ceiling.
 *
 * This deliberately BYPASSES the brain entirely. For each question it dumps
 * the ENTIRE dated conversation transcript into a single LLM call and asks it
 * to answer. No extraction, no memory, no retrieval — the "just keep all the
 * text" reference that the memory-systems literature reports at ~73% on LoCoMo
 * (Mem0 paper full-context baseline 72.9%; Letta filesystem+grep ~74%).
 *
 * Why it exists: our extracted-memory pipeline plateaus at ~47-52%. If a naive
 * full-context dump on OUR harness / OUR judge also beats that, the deficit is
 * information LOST at extraction time, not retrieval — the load-bearing premise
 * of the dialogue-memory rebuild. We measure it on our own turf before building
 * on the claim, using the SAME judge (test/eval/locomo/judge.ts) so the number
 * is directly comparable to run-locomo's judgeAccuracy.
 *
 *   OPENAI_API_KEY=... ts-node -r tsconfig-paths/register -T \
 *     scripts/locomo-fullcontext-baseline.ts \
 *     --dataset /tmp/locomo10.json --samples 5 --concurrency 6 \
 *     --model gpt-4o-mini --judge-model gpt-4.1-mini \
 *     --out var/locomo-fullcontext-dev5.json
 *
 * Same conversations as a run-locomo --samples N run → subtract the two
 * judgeAccuracy numbers to get the extraction information-loss on our turf.
 */
import { promises as fs } from 'node:fs';
import OpenAI from 'openai';
import { loadLocomoDataset } from '../test/eval/locomo/loader';
import { createOpenAiJudge } from '../test/eval/locomo/judge';
import {
  LOCOMO_CATEGORY_NAMES,
  type NormalizedConversation,
  type LocomoQuestion,
} from '../test/eval/locomo/types';
import { parseFlags } from '../test/eval/harness/flags';
import { runPool } from '../test/eval/harness/pool';
import { loadCheckpoint, appendCheckpoint } from '../test/eval/checkpoint';

interface Args extends Record<string, unknown> {
  dataset: string;
  samples?: number;
  /** Skip the first N conversations before --samples (held-out block). */
  sampleOffset?: number;
  maxQuestions?: number;
  model: string;
  judgeModel: string;
  concurrency: number;
  out: string;
  openaiApiKey?: string;
  /** Include cat5 (adversarial) in the run — scored as abstention, not headline. */
  includeAdversarial: boolean;
  /** JSONL checkpoint: finished questions survive quota deaths. */
  resume?: string;
}

const FLAGS = {
  '--dataset': { key: 'dataset', type: 'string' },
  '--samples': { key: 'samples', type: 'int' },
  '--sample-offset': { key: 'sampleOffset', type: 'int' },
  '--max-questions': { key: 'maxQuestions', type: 'int' },
  '--model': { key: 'model', type: 'string' },
  '--judge-model': { key: 'judgeModel', type: 'string' },
  '--concurrency': { key: 'concurrency', type: 'int' },
  '--out': { key: 'out', type: 'string' },
  '--include-adversarial': { key: 'includeAdversarial', type: 'bool' },
  '--resume': { key: 'resume', type: 'string' },
} as const;

function parseArgs(argv: string[]): Args {
  const args = parseFlags<Args>(argv, FLAGS, {
    dataset: '',
    model: process.env.LOCOMO_FC_MODEL ?? 'gpt-4o-mini',
    judgeModel: process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
    concurrency: 6,
    out: 'locomo-fullcontext.json',
    openaiApiKey: process.env.OPENAI_API_KEY,
    includeAdversarial: false,
  });
  if (!args.dataset) throw new Error('missing --dataset path/to/locomo10.json');
  if (!args.openaiApiKey) throw new Error('OPENAI_API_KEY env required');
  return args;
}

/** Render the whole conversation as a dated, speaker-attributed transcript. */
function renderTranscript(conv: NormalizedConversation): string {
  const parts: string[] = [];
  for (const s of conv.sessions) {
    const date = s.dateTime && s.dateTime !== new Date(0).toISOString()
      ? s.dateTime
      : `session ${s.index}`;
    parts.push(`=== Session ${s.index} — ${date} ===`);
    for (const t of s.turns) {
      // Image turns carry a caption that often holds the answer-bearing detail.
      const cap = t.blip_caption ? ` [shares an image: ${t.blip_caption}]` : '';
      parts.push(`${t.speaker}: ${t.text}${cap}`);
    }
  }
  return parts.join('\n');
}

const SYSTEM = (a: string, b: string) =>
  `You answer questions about a long, multi-session conversation between ${a} and ${b}. ` +
  `Use ONLY information stated in the conversation transcript. Reason across sessions and dates as needed. ` +
  `Answer if the information is present — do not decline just because it is spread across turns; ` +
  `gather every relevant item (list answers must be COMPLETE, e.g. all activities/places/books mentioned). ` +
  `Only if the transcript genuinely contains nothing relevant, reply exactly "No information available." ` +
  `Answer concisely — the direct answer only, no explanation, but never omit a list item.`;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // 429 / 5xx are transient — exponential backoff. Others rethrow.
      if (status !== 429 && status !== undefined && status < 500) throw err;
      const waitMs = 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`${label} failed after retries: ${(lastErr as Error)?.message}`);
}

interface QAItem {
  sampleId: string;
  transcript: string;
  speakerA: string;
  speakerB: string;
  q: LocomoQuestion;
}

interface Scored {
  sampleId: string;
  category: number;
  question: string;
  gold: string;
  prediction: string;
  correct: boolean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new OpenAI({ apiKey: args.openaiApiKey });
  const judge = createOpenAiJudge(client, args.judgeModel);

  const all = await loadLocomoDataset(args.dataset);
  const off = args.sampleOffset ?? 0;
  const convs = args.samples ? all.slice(off, off + args.samples) : all.slice(off);

  // Flatten to a work list, rendering each transcript once per sample.
  const items: QAItem[] = [];
  for (const conv of convs) {
    const transcript = renderTranscript(conv);
    for (const q of conv.qa) {
      if (q.category === 5 && !args.includeAdversarial) continue;
      items.push({
        sampleId: conv.sampleId,
        transcript,
        speakerA: conv.speakerA,
        speakerB: conv.speakerB,
        q,
      });
    }
  }
  const work = args.maxQuestions ? items.slice(0, args.maxQuestions) : items;
  console.error(
    `[fc] dataset=${args.dataset} samples=${convs.length} questions=${work.length} ` +
      `model=${args.model} judge=${args.judgeModel} concurrency=${args.concurrency}`,
  );

  const restored = await loadCheckpoint<Scored>(
    args.resume,
    (s) => `${s.sampleId}::${s.category}::${s.question}`,
  );
  const scored: Scored[] = new Array(work.length);
  let done = 0;

  await runPool(args.concurrency, work, async (it, idx) => {
    const prior = restored.get(
      `${it.sampleId}::${it.q.category}::${it.q.question}`,
    );
    if (prior) {
      scored[idx] = prior;
      done++;
      return;
    }
    const prediction = await withRetry(async () => {
      const res = await client.chat.completions.create({
        model: args.model,
        messages: [
          { role: 'system', content: SYSTEM(it.speakerA, it.speakerB) },
          {
            role: 'user',
            content: `${it.transcript}\n\nQuestion: ${it.q.question}\nAnswer:`,
          },
        ],
        max_completion_tokens: 300,
        temperature: 0,
      });
      return res.choices?.[0]?.message?.content?.trim() ?? '';
    }, `answer[${it.sampleId}#${idx}]`);

    const { correct } = await withRetry(
      () =>
        judge.grade({
          question: it.q.question,
          gold: it.q.answer,
          prediction,
          category: it.q.category,
        }),
      `judge[${it.sampleId}#${idx}]`,
    );

    scored[idx] = {
      sampleId: it.sampleId,
      category: it.q.category,
      question: it.q.question,
      gold: it.q.answer,
      prediction,
      correct,
    };
    await appendCheckpoint(args.resume, scored[idx]);
    done++;
    if (done % 20 === 0 || done === work.length) {
      console.error(`[fc] ${done}/${work.length}`);
    }
  });

  // Aggregate: headline = cat1-4 judgeAccuracy; per-category and per-sample.
  const headline = scored.filter((s) => s.category >= 1 && s.category <= 4);
  const acc = (rows: Scored[]) =>
    rows.length ? rows.filter((r) => r.correct).length / rows.length : 0;

  const byCategory: Record<string, { n: number; correct: number; acc: number }> = {};
  for (const cat of [1, 2, 3, 4, 5]) {
    const rows = scored.filter((s) => s.category === cat);
    if (!rows.length) continue;
    byCategory[cat] = {
      n: rows.length,
      correct: rows.filter((r) => r.correct).length,
      acc: acc(rows),
    };
  }
  const bySample: Record<string, { n: number; correct: number; acc: number }> = {};
  for (const conv of convs) {
    const rows = headline.filter((s) => s.sampleId === conv.sampleId);
    bySample[conv.sampleId] = {
      n: rows.length,
      correct: rows.filter((r) => r.correct).length,
      acc: acc(rows),
    };
  }

  const report = {
    kind: 'fullcontext-baseline',
    model: args.model,
    judgeModel: args.judgeModel,
    dataset: args.dataset,
    samples: convs.map((c) => c.sampleId),
    headlineJudgeAccuracy: acc(headline),
    headlineN: headline.length,
    byCategory,
    bySample,
    scores: scored,
  };
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));

  console.error('\n=== FULL-CONTEXT BASELINE ===');
  console.error(
    `headline (cat1-4) judgeAccuracy: ${(report.headlineJudgeAccuracy * 100).toFixed(1)}%  (n=${headline.length})`,
  );
  for (const [cat, v] of Object.entries(byCategory)) {
    const name = LOCOMO_CATEGORY_NAMES[Number(cat)];
    console.error(`  cat${cat} ${name?.padEnd(11)}: ${(v.acc * 100).toFixed(1)}%  (${v.correct}/${v.n})`);
  }
  console.error('  per-sample:');
  for (const [sid, v] of Object.entries(bySample)) {
    console.error(`    ${sid.padEnd(10)}: ${(v.acc * 100).toFixed(1)}%  (${v.correct}/${v.n})`);
  }
  console.error(`\nwrote ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
