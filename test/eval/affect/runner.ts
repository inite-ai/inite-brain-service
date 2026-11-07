/**
 * eval:affect (#909) — does the affect reader read how a person feels, and
 * does it keep quiet when there is nothing to read? Keyless: the model is
 * whoever answers the emitted requests (harness mode — a connected agent,
 * or a subagent in a measurement session); the server's own model is never
 * called here.
 *
 *   pnpm eval:affect emit  --set=goemotions|dialogues [--n=200] [--out=var/affect]
 *   pnpm eval:affect score --set=goemotions|dialogues [--out=var/affect] [--json]
 *
 * `emit` writes <out>/<set>.requests.jsonl — one request per item, exactly
 * what the reader sends (AFFECT_READING_SYSTEM + affectReadingUser), plus
 * the gold. The answerer writes <out>/<set>.answers.jsonl, one
 * `{"id", "answer": {"observations": [...]}}` per line, in the reader's
 * schema. `score` passes every answer through the reader's own parser
 * (parseAffectReading), so a reading that quotes words the turn does not
 * contain counts as no reading — what production would keep.
 *
 * Sets:
 *  - goemotions: Reddit comments with human emotion labels (Demszky et al.
 *    2020, CC BY 4.0), test split, folded to Ekman's six + neutral by the
 *    dataset's own mapping. Fetched at run time from the HF datasets
 *    server and the GoEmotions repository — no data is vendored.
 *  - dialogues: hand-written conversations in en / ru / pt (dialogues.json)
 *    with traps — sarcasm, quoted feelings, someone else's feeling,
 *    hypotheticals, formulas, opinions — where a careful reader reads
 *    nothing, or something other than the surface.
 *
 * Measures:
 *  - detection P / R / F1: does the reading find feeling where a human
 *    found it (any label) and nothing where a human found none;
 *  - label accuracy: of turns both found emotional, the share where a read
 *    label is one the human gave; macro-F1 over the six labels;
 *  - false-positive rate on turns with nothing to read, overall and by trap;
 *  - calibration: ECE over observations, 10 equal-width confidence bins,
 *    an observation correct when its label is one the human gave.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AFFECT_LABELS,
  AFFECT_READING_SYSTEM,
  affectReadingUser,
  parseAffectReading,
  type AffectTurn,
} from '../../../src/affect/affect-reading';

type Label = (typeof AFFECT_LABELS)[number];
const EMOTIONS = AFFECT_LABELS.filter((l) => l !== 'neutral');

interface GoldTurn {
  handle: string;
  gold: Label[];
  trap?: string;
}

interface Request {
  id: string;
  lang: string;
  system: string;
  user: string;
  turns: AffectTurn[];
  gold: GoldTurn[];
}

const DATASET = 'google-research-datasets/go_emotions';
const SERVER = 'https://datasets-server.huggingface.co';
const EKMAN_URL =
  'https://raw.githubusercontent.com/google-research/google-research/master/goemotions/data/ekman_mapping.json';
/** Rows of the simplified test split. */
const GOEMOTIONS_TEST_ROWS = 5427;

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function getJson<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url);
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return getJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** GoEmotions test rows at an even stride: n single-turn requests. */
async function emitGoEmotions(n: number): Promise<Request[]> {
  const info = await getJson<{
    dataset_info: { features: { labels: { feature: { names: string[] } } } };
  }>(`${SERVER}/info?dataset=${DATASET}&config=simplified`);
  const names = info.dataset_info.features.labels.feature.names;
  const ekman = await getJson<Record<string, string[]>>(EKMAN_URL);
  const toEkman = new Map<string, Label>();
  for (const [label, fine] of Object.entries(ekman)) {
    for (const f of fine) toEkman.set(f, label as Label);
  }
  // Pages of 100 spread over the split, every other row of each: n rows in
  // n/50 requests (the datasets server rate-limits row-by-row reads).
  const pages = Math.ceil(n / 50);
  const pageStride = Math.floor((GOEMOTIONS_TEST_ROWS - 100) / Math.max(1, pages - 1));
  const out: Request[] = [];
  for (let p = 0; p < pages && out.length < n; p++) {
    const page = await getJson<{
      rows: Array<{ row: { id: string; text: string; labels: number[] } }>;
    }>(
      `${SERVER}/rows?dataset=${DATASET}&config=simplified&split=test&offset=${p * pageStride}&length=100`,
    );
    for (const [i, { row }] of page.rows.entries()) {
      if (i % 2 === 1 || out.length >= n) continue;
      const gold = [
        ...new Set(
          row.labels
            .map((l) => names[l]!)
            .filter((name) => name !== 'neutral')
            .map((name) => toEkman.get(name)!)
            .filter(Boolean),
        ),
      ];
      const turns: AffectTurn[] = [
        {
          handle: 't1',
          speaker: 'writer',
          own: true,
          text: row.text,
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      out.push({
        id: `ge-${row.id}`,
        lang: 'en',
        system: AFFECT_READING_SYSTEM,
        user: affectReadingUser('writer', turns),
        turns,
        gold: [{ handle: 't1', gold }],
      });
    }
  }
  return out;
}

function emitDialogues(): Request[] {
  const file = JSON.parse(readFileSync(join(__dirname, 'dialogues.json'), 'utf8')) as {
    conversations: Array<{
      id: string;
      lang: string;
      person: string;
      turns: Array<{ speaker: string; text: string; own?: boolean; gold?: Label[]; trap?: string }>;
    }>;
  };
  return file.conversations.map((c) => {
    const turns: AffectTurn[] = c.turns.map((t, i) => ({
      handle: `t${i + 1}`,
      speaker: t.speaker,
      own: t.own === true,
      text: t.text,
      occurredAt: new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString(),
    }));
    const gold = c.turns.flatMap((t, i) =>
      t.own
        ? [{ handle: `t${i + 1}`, gold: t.gold ?? [], ...(t.trap ? { trap: t.trap } : {}) }]
        : [],
    );
    return {
      id: c.id,
      lang: c.lang,
      system: AFFECT_READING_SYSTEM,
      user: affectReadingUser(c.person, turns),
      turns,
      gold,
    };
  });
}

interface Tally {
  tp: number;
  fp: number;
  fn: number;
}

export interface AffectScore {
  set: string;
  turns: number;
  detection: { precision: number; recall: number; f1: number };
  labelAccuracy: number;
  macroF1: number;
  falsePositiveRate: number;
  falsePositivesByTrap: Record<string, { turns: number; falsePositives: number }>;
  /** Of trap turns with a feeling to read, the share read with a gold label. */
  trapLabelAccuracy: number;
  ece: number;
  reliability: Array<{ bin: string; n: number; meanConfidence: number; accuracy: number }>;
  observations: number;
  droppedByParser: number;
  byLang: Record<string, { turns: number; f1: number; falsePositiveRate: number }>;
}

const f1 = (t: Tally) => {
  const p = t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp);
  const r = t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn);
  return { precision: p, recall: r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) };
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function scoreAffect(
  set: string,
  requests: readonly Request[],
  answers: ReadonlyMap<string, unknown>,
): AffectScore {
  const detection: Tally = { tp: 0, fp: 0, fn: 0 };
  const perLabel = new Map<Label, Tally>(EMOTIONS.map((l) => [l, { tp: 0, fp: 0, fn: 0 }]));
  const byLang = new Map<
    string,
    { tally: Tally; neutral: number; neutralFp: number; turns: number }
  >();
  const traps = new Map<string, { turns: number; falsePositives: number }>();
  let bothEmotional = 0;
  let labelHits = 0;
  let neutralTurns = 0;
  let neutralFp = 0;
  let trapEmotional = 0;
  let trapHits = 0;
  let turnsScored = 0;
  let observations = 0;
  let dropped = 0;
  const confidences: Array<{ c: number; ok: boolean }> = [];
  for (const req of requests) {
    const raw = answers.get(req.id);
    const rawCount = Array.isArray((raw as { observations?: unknown[] })?.observations)
      ? (raw as { observations: unknown[] }).observations.length
      : 0;
    const drafts = parseAffectReading(raw ?? { observations: [] }, req.turns);
    observations += drafts.length;
    dropped += rawCount - drafts.length;
    const lang = byLang.get(req.lang) ?? {
      tally: { tp: 0, fp: 0, fn: 0 },
      neutral: 0,
      neutralFp: 0,
      turns: 0,
    };
    for (const g of req.gold) {
      turnsScored += 1;
      lang.turns += 1;
      const read = drafts.filter((d) => d.handle === g.handle);
      const readLabels = new Set(read.map((d) => d.label).filter((l) => l !== 'neutral'));
      const goldSet = new Set(g.gold);
      const goldEmotional = goldSet.size > 0;
      const readEmotional = readLabels.size > 0;
      for (const d of read) confidences.push({ c: d.confidence, ok: goldSet.has(d.label) });
      if (goldEmotional && readEmotional) {
        detection.tp += 1;
        lang.tally.tp += 1;
        bothEmotional += 1;
        if ([...readLabels].some((l) => goldSet.has(l))) labelHits += 1;
      } else if (!goldEmotional && readEmotional) {
        detection.fp += 1;
        lang.tally.fp += 1;
      } else if (goldEmotional && !readEmotional) {
        detection.fn += 1;
        lang.tally.fn += 1;
      }
      if (!goldEmotional) {
        neutralTurns += 1;
        lang.neutral += 1;
        if (readEmotional) {
          neutralFp += 1;
          lang.neutralFp += 1;
        }
      }
      if (g.trap) {
        const t = traps.get(g.trap) ?? { turns: 0, falsePositives: 0 };
        t.turns += 1;
        // A trap's false reading: anything read on a turn with nothing, or
        // only labels the human did not give on a turn with a feeling.
        const wrong = goldEmotional
          ? readEmotional && ![...readLabels].some((l) => goldSet.has(l))
          : readEmotional;
        if (wrong) t.falsePositives += 1;
        traps.set(g.trap, t);
        if (goldEmotional) {
          trapEmotional += 1;
          if ([...readLabels].some((l) => goldSet.has(l))) trapHits += 1;
        }
      }
      for (const l of EMOTIONS) {
        const t = perLabel.get(l)!;
        if (goldSet.has(l) && readLabels.has(l)) t.tp += 1;
        else if (!goldSet.has(l) && readLabels.has(l)) t.fp += 1;
        else if (goldSet.has(l) && !readLabels.has(l)) t.fn += 1;
      }
    }
    byLang.set(req.lang, lang);
  }
  const bins = Array.from({ length: 10 }, () => ({ n: 0, c: 0, ok: 0 }));
  for (const { c, ok } of confidences) {
    const b = bins[Math.min(9, Math.floor(c * 10))]!;
    b.n += 1;
    b.c += c;
    if (ok) b.ok += 1;
  }
  const total = confidences.length;
  const ece = bins.reduce(
    (sum, b) => (b.n === 0 ? sum : sum + (b.n / total) * Math.abs(b.ok / b.n - b.c / b.n)),
    0,
  );
  const labelsWithGold = EMOTIONS.filter((l) => {
    const t = perLabel.get(l)!;
    return t.tp + t.fn > 0;
  });
  return {
    set,
    turns: turnsScored,
    detection: Object.fromEntries(
      Object.entries(f1(detection)).map(([k, v]) => [k, r3(v)]),
    ) as AffectScore['detection'],
    labelAccuracy: r3(bothEmotional === 0 ? 0 : labelHits / bothEmotional),
    macroF1: r3(
      labelsWithGold.reduce((s, l) => s + f1(perLabel.get(l)!).f1, 0) /
        Math.max(1, labelsWithGold.length),
    ),
    falsePositiveRate: r3(neutralTurns === 0 ? 0 : neutralFp / neutralTurns),
    falsePositivesByTrap: Object.fromEntries(traps),
    trapLabelAccuracy: r3(trapEmotional === 0 ? 0 : trapHits / trapEmotional),
    ece: r3(total === 0 ? 0 : ece),
    reliability: bins
      .map((b, i) => ({
        bin: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
        n: b.n,
        meanConfidence: r3(b.n ? b.c / b.n : 0),
        accuracy: r3(b.n ? b.ok / b.n : 0),
      }))
      .filter((b) => b.n > 0),
    observations,
    droppedByParser: dropped,
    byLang: Object.fromEntries(
      [...byLang].map(([l, v]) => [
        l,
        {
          turns: v.turns,
          f1: r3(f1(v.tally).f1),
          falsePositiveRate: r3(v.neutral === 0 ? 0 : v.neutralFp / v.neutral),
        },
      ]),
    ),
  };
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const set = arg('set', 'dialogues')!;
  const out = arg('out', 'var/affect')!;
  mkdirSync(out, { recursive: true });
  const requestsPath = join(out, `${set}.requests.jsonl`);
  if (command === 'emit') {
    const requests =
      set === 'goemotions' ? await emitGoEmotions(Number(arg('n', '200'))) : emitDialogues();
    writeFileSync(requestsPath, requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`wrote ${requests.length} requests → ${requestsPath}`);
    return;
  }
  if (command === 'score') {
    const requests = readFileSync(requestsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Request);
    const answers = new Map<string, unknown>();
    for (const line of readFileSync(join(out, `${set}.answers.jsonl`), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const a = JSON.parse(line) as { id: string; answer: unknown };
      answers.set(a.id, a.answer);
    }
    const score = scoreAffect(set, requests, answers);
    console.log(process.argv.includes('--json') ? JSON.stringify(score, null, 2) : render(score));
    return;
  }
  throw new Error('usage: eval:affect emit|score --set=goemotions|dialogues');
}

function render(s: AffectScore): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `affect battery — ${s.set} (${s.turns} turns, ${s.observations} observations, ${s.droppedByParser} dropped by the parser)`,
    `detection P ${pct(s.detection.precision)} · R ${pct(s.detection.recall)} · F1 ${pct(s.detection.f1)}`,
    `label accuracy ${pct(s.labelAccuracy)} · macro-F1 ${pct(s.macroF1)}`,
    `false positives on turns with nothing to read: ${pct(s.falsePositiveRate)}`,
    `ECE ${s.ece}`,
    ...Object.entries(s.falsePositivesByTrap).map(
      ([trap, t]) => `  trap ${trap}: ${t.falsePositives}/${t.turns} misread`,
    ),
    ...s.reliability.map(
      (b) => `  conf ${b.bin}: n=${b.n} mean ${b.meanConfidence} → accuracy ${b.accuracy}`,
    ),
    ...Object.entries(s.byLang).map(
      ([l, v]) => `  ${l}: ${v.turns} turns · F1 ${pct(v.f1)} · FP ${pct(v.falsePositiveRate)}`,
    ),
  ];
  return lines.join('\n');
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
