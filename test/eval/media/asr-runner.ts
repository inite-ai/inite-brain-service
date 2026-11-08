/**
 * Media battery, part two: does the speech reader hear? (#900 step 4)
 *
 * Recordings of the kinds a memory receives (asr-dataset.json; the mp3s in
 * audio/) through the real AsrAdapter: the shipped ffmpeg decodes, Whisper
 * (EVIDENCE_ASR_MODEL, transformers.js) transcribes. Scored on WER against
 * what was said, and on keys: the share of what memory must keep that the
 * transcript holds in any accepted spelling.
 *
 * Two arms: with the tenant's language (what the broker passes) and with
 * none, which shows why the language is passed: Whisper in transformers.js
 * does not detect it and transcribes as English.
 *
 * Free: local model (downloaded once into the transformers cache) and a
 * local binary; no key, no database.
 *
 * Run: pnpm eval:media-asr
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AsrAdapter } from '../../../src/evidence/processing/adapters/asr.adapter';
import type { ProcessorInput } from '../../../src/evidence/processing/processor-adapter';

interface Item {
  id: string;
  lang: string;
  text: string;
  keys: string[][];
}

const words = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function input(bytes: Buffer, tenantLang: string | undefined): ProcessorInput {
  return {
    asset: {
      id: 'evidence_asset:asr_battery',
      modality: 'audio',
      mediaType: 'audio/mpeg',
      availability: 'hot',
      byteLength: bytes.byteLength,
    },
    openStream: () => Promise.resolve(Readable.from([bytes])),
    tenantLang,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

async function main(): Promise<void> {
  process.env.EVIDENCE_ASR_ENABLED = '1';
  const items = (
    JSON.parse(readFileSync(join(__dirname, 'asr-dataset.json'), 'utf8')) as { items: Item[] }
  ).items;
  const adapter = new AsrAdapter();
  const rows: Array<{
    id: string;
    lang: string;
    arm: string;
    wer: number;
    keys: number;
    text: string;
  }> = [];
  for (const item of items) {
    const bytes = readFileSync(join(__dirname, 'audio', `${item.id}.mp3`));
    for (const arm of ['tenant language', 'no language'] as const) {
      const started = Date.now();
      const outputs = await adapter.process(
        input(bytes, arm === 'tenant language' ? item.lang : undefined),
      );
      const heard = outputs.map((o) => o.content ?? '').join(' ');
      const said = words(item.text);
      const got = words(heard);
      const flat = got.join(' ');
      rows.push({
        id: item.id,
        lang: item.lang,
        arm,
        wer: Math.min(1, editDistance(said, got) / said.length),
        keys:
          item.keys.filter((k) => k.some((v) => flat.includes(words(v).join(' ')))).length /
          item.keys.length,
        text: heard,
      });
      console.error(`${item.id} [${arm}] ${Date.now() - started} ms: ${heard}`);
    }
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`model: ${process.env.EVIDENCE_ASR_MODEL ?? 'Xenova/whisper-small'}\n`);
  console.log('arm\tlang\tWER\tkeys');
  for (const arm of ['tenant language', 'no language']) {
    for (const lang of [...new Set(items.map((i) => i.lang))]) {
      const rs = rows.filter((r) => r.arm === arm && r.lang === lang);
      console.log(
        `${arm}\t${lang}\t${pct(mean(rs.map((r) => r.wer)))}\t${pct(mean(rs.map((r) => r.keys)))}`,
      );
    }
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
