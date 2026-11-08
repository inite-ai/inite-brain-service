# Media battery

Part one of the media measurements (#900, step 1): **does the image reader
read?** Brain stores images, and the OCR adapter
(`src/evidence/processing/adapters/ocr.adapter.ts`, tesseract.js WASM) is
the only thing that turns one into words. Until this battery, nothing
measured how well it does that.

```
pnpm eval:media [--langs=eng+rus] [--json]
```

The battery is free: a local engine, no model, no key, no database.

## What it does

`dataset.json` holds 12 hand-written texts of the kinds a memory receives
as images: an invoice, a dashboard, a chat screenshot, a slide, a boarding
pass and a ticket, in English, Russian and Portuguese. Each text lists its
`keys`, the exact strings memory must not misremember: numbers, codes,
names and dates.

Each text is rendered in-process by sharp (no binary fixtures) in six
variants:

- `clean`
- `small` (110 dpi)
- `low_contrast`
- `rotated` (4°)
- `jpeg` (quality 15)
- `blur` (σ 1.6)

Every variant is read by the real adapter and scored on three measures:

- **CER / WER:** edit distance to the ground truth over characters and
  over words, after case and whitespace are normalised.
- **keys:** the share of `keys` found verbatim.

A run the adapter refuses (nothing legible above its confidence floor)
scores as empty.

## Result (2026-11-03, `eng+rus`, the shipped models)

| variant      | en CER / WER / keys | ru CER / WER / keys | pt CER / WER / keys   |
| ------------ | ------------------- | ------------------- | --------------------- |
| clean        | 0.5% / 1.9% / 95.0% | 1.6% / 6.2% / 96.0% | 10.5% / 29.8% / 75.0% |
| small        | 0.1% / 0.8% / 100%  | 0.4% / 2.6% / 96.0% | 25.1% / 34.5% / 75.0% |
| low_contrast | 0.5% / 1.9% / 95.0% | 1.2% / 5.2% / 96.0% | 17.2% / 27.4% / 75.0% |
| rotated      | 1.3% / 5.5% / 90.0% | 3.7% / 5.2% / 89.3% | 22.3% / 38.1% / 41.7% |
| jpeg         | 0.7% / 1.9% / 95.0% | 3.0% / 5.0% / 89.3% | 11.4% / 29.8% / 75.0% |
| blur         | 0.1% / 0.8% / 100%  | 1.1% / 4.7% / 96.0% | 14.4% / 29.8% / 75.0% |
| **all**      | 0.6% / 2.1% / 95.8% | 1.8% / 4.8% / 93.8% | 16.8% / 31.5% / 69.4% |

What it shows:

- **English and Russian read well.** CER is under 2% and 94–96% of keys
  survive, including on low-quality JPEGs and blur. A 4° rotation is the
  costliest degradation.
- **Portuguese does not read well.** No Portuguese model ships, so
  diacritics are lost ("manutenção" → "manutencéo") and, with the Russian
  model loaded alongside, Latin letters come back as Cyrillic
  ("Conceição" → "Сопсе!сао"). Every language a memory holds needs its
  model; that is step 2 of #900.
- **The confidence floor barely matters on legible text.** With the floor
  at 0 instead of 60, `all` moves to 0.4% / 96.7% keys (en) and
  1.1% / 96.0% (ru).

The renderer had a trap, kept here so nobody repeats it. sharp renders text
white-on-black in one band, so the margin `extend` adds after the negate
was black. The glyphs touched a black edge, and tesseract lost the first
letter of most lines ("Flight" read as "ight"), which made clean English
look like 77% keys. The margin is now added in sRGB and in white. The
adapter's unit test renderer has the same shape; its assertions do not
depend on first letters.

## Part two: does the speech reader hear?

```
pnpm eval:media-asr
```

Six recordings (`audio/`, about 180 KB in total) of the kinds a memory
receives: a call summary, a stand-up and a note, in EN, RU and PT. The
macOS system voices (Samantha, Daniel, Milena, Luciana) speak them and the
shipped ffmpeg encodes them to 32 kbit/s mono mp3. `asr-dataset.json`
holds what was said, plus the keys with every accepted spelling, since a
number may come back as digits or as words.

Each recording runs through the real `AsrAdapter` (ffmpeg decode, Whisper
via transformers.js) in two arms:

- with the tenant's language, which is what the broker passes;
- with no language.

Result (2026-11-03, `Xenova/whisper-small`, CPU, about half real time):

| arm             | lang | WER   | keys      |
| --------------- | ---- | ----- | --------- |
| tenant language | en   | 20.9% | **100%**  |
| tenant language | ru   | 26.3% | **83.3%** |
| tenant language | pt   | 32.4% | **100%**  |
| no language     | ru   | 100%  | 29.2%     |
| no language     | pt   | 95.2% | 58.3%     |

What it shows:

- **The keys survive** (numbers, names, dates, codes): 100% in English and
  Portuguese. Russian is at 83.3% because "пароль" was heard as "пороль".
- **WER overstates the errors.** It counts "forty eight thousand" against
  "$48,000" as three errors; the keys accept both spellings, so the key
  score is the better measure here.
- **The language must be passed.** Without it, Whisper in transformers.js
  does not detect the language and translates Russian and Portuguese into
  English ("Созвон с клиентом перенесли на среду" → "The client was called
  to transfer the contract…"). That is why the run reads in the tenant's
  language.

Part two, whether the words an image yields reach searchable memory,
lands with the change that wires OCR into memory (#900, step 2).
