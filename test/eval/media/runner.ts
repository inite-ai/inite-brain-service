/**
 * Media battery, part one: does the image reader read? (#900, step 1)
 *
 * The OCR adapter (src/evidence/processing/adapters/ocr.adapter.ts) is the
 * only thing that turns an image into words, and nothing measured how well
 * it does that. This scores it on texts of the kinds a memory receives as
 * images (dataset.json), each rendered in-process by sharp — the same
 * renderer the adapter's unit test uses, so no binary fixtures — in the
 * degradations real screenshots and photos carry.
 *
 * Per item and variant:
 *  - CER / WER: edit distance between the ground truth and what the
 *    adapter returned, over characters and over words, after whitespace
 *    and case are normalised;
 *  - keys: the share of the item's exact strings (numbers, codes, names,
 *    dates) found verbatim — what a memory must not misremember.
 * A run the adapter refuses (no text above its confidence floor) reads as
 * empty: CER 1, no keys.
 *
 * Mechanical and free: local WASM engine, no model, no key, no database.
 *
 * Run: pnpm eval:media [--langs=eng+rus] [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { OcrAdapter } from '../../../src/evidence/processing/adapters/ocr.adapter';
import type { ProcessorInput } from '../../../src/evidence/processing/processor-adapter';

interface Item {
  id: string;
  lang: string;
  text: string;
  keys: string[];
}

sharp.concurrency(1);
sharp.cache(false);

/**
 * Dark type on white with a white margin, as a screenshot looks. sharp
 * renders text white-on-black in one band; extending that band paints the
 * margin black after the negate, so the glyphs touched a black edge and
 * tesseract lost each line's first letter (measured: "Flight" read as
 * "ight"). The margin is added in sRGB, after the negate, in white.
 */
async function render(text: string, dpi: number): Promise<Buffer> {
  const glyphs = await sharp({ text: { text, width: 1400, dpi, rgba: false } })
    .negate()
    .png()
    .toBuffer();
  return sharp(glyphs)
    .toColourspace('srgb')
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

/** The degradations an image of text arrives with. */
const VARIANTS: Record<string, (text: string) => Promise<Buffer>> = {
  clean: (t) => render(t, 300),
  small: (t) => render(t, 110),
  low_contrast: async (t) =>
    sharp(await render(t, 300))
      .linear(0.3, 170)
      .png()
      .toBuffer(),
  rotated: async (t) =>
    sharp(await render(t, 300))
      .rotate(4, { background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer(),
  jpeg: async (t) =>
    sharp(await render(t, 200))
      .jpeg({ quality: 15 })
      .toBuffer(),
  blur: async (t) =>
    sharp(await render(t, 300))
      .blur(1.6)
      .png()
      .toBuffer(),
};

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function editDistance<T>(a: readonly T[], b: readonly T[]): number {
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

function score(truth: string, read: string, keys: string[]) {
  const t = norm(truth);
  const r = norm(read);
  const tw = t.split(' ');
  const rw = r ? r.split(' ') : [];
  return {
    cer: Math.min(1, editDistance([...t], [...r]) / t.length),
    wer: Math.min(1, editDistance(tw, rw) / tw.length),
    keys: keys.filter((k) => r.includes(norm(k))).length / keys.length,
  };
}

function input(bytes: Buffer, mediaType: string): ProcessorInput {
  return {
    asset: {
      id: 'evidence_asset:media_battery',
      modality: 'image',
      mediaType,
      availability: 'hot',
      byteLength: bytes.byteLength,
    },
    openStream: () => Promise.resolve(Readable.from([bytes])),
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function main(): Promise<void> {
  const langsArg = process.argv.find((a) => a.startsWith('--langs='));
  process.env.EVIDENCE_OCR_ENABLED = '1';
  process.env.EVIDENCE_OCR_LANGS = langsArg?.slice(8) ?? 'eng+rus';
  const items = (
    JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf8')) as { items: Item[] }
  ).items;
  const adapter = new OcrAdapter();
  const rows: Array<{ id: string; lang: string; variant: string } & ReturnType<typeof score>> = [];
  for (const item of items) {
    for (const [variant, make] of Object.entries(VARIANTS)) {
      const bytes = await make(item.text);
      let read = '';
      try {
        const outputs = await adapter.process(
          input(bytes, variant === 'jpeg' ? 'image/jpeg' : 'image/png'),
        );
        read = outputs.map((o) => (o.content ?? '').replace(/\n\[ocr: [^\]]*\]/g, '')).join('\n');
      } catch {
        // Refused: nothing legible above the floor. Scored as empty.
      }
      rows.push({ id: item.id, lang: item.lang, variant, ...score(item.text, read, item.keys) });
    }
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const langs = [...new Set(rows.map((r) => r.lang))];
  console.log(`OCR langs: ${process.env.EVIDENCE_OCR_LANGS}\n`);
  console.log(['variant', ...langs.map((l) => `${l} CER / WER / keys`)].join('\t'));
  for (const variant of Object.keys(VARIANTS)) {
    const cells = langs.map((l) => {
      const rs = rows.filter((r) => r.variant === variant && r.lang === l);
      return `${pct(mean(rs.map((r) => r.cer)))} / ${pct(mean(rs.map((r) => r.wer)))} / ${pct(mean(rs.map((r) => r.keys)))}`;
    });
    console.log([variant, ...cells].join('\t'));
  }
  const all = (l: string) => rows.filter((r) => r.lang === l);
  console.log(
    [
      'all',
      ...langs.map(
        (l) =>
          `${pct(mean(all(l).map((r) => r.cer)))} / ${pct(mean(all(l).map((r) => r.wer)))} / ${pct(mean(all(l).map((r) => r.keys)))}`,
      ),
    ].join('\t'),
  );
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
