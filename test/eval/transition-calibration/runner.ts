/**
 * Offline calibration harness for the transition-classifier lane
 * (EXTRACTOR_TRANSITION_CLASSIFIER) — sweeps the score-floor / margin
 * gates over the EXACT wired pipeline (findHarvestCandidates → one
 * classify() batch → threshold acceptance) and prints precision/recall
 * per grid point, so TRANSITION_SCORE_FLOOR / TRANSITION_MARGIN_DEFAULT
 * are measurements, not guesses.
 *
 *   pnpm eval:transition-calibration
 *
 * Embedder: the REAL production model — Xenova/bge-m3 (quantized ONNX,
 * cls-pooled, normalized; byte-identical to BgeM3EmbedderProvider's
 * in-thread path). Local inference only: no service, no paid API. The
 * first run downloads the model into @xenova/transformers' cache
 * (~230 MB, free); later runs are fully offline and deterministic.
 * Deliberately NOT a jest spec — real ONNX inside jest workers is the
 * known native-heap-corruption source (CI SIGABRT, 2026-08-26).
 *
 * Dataset: labeled sentences with sources pinned in-line —
 *  - positives: the transition turns of test/eval/state-transitions/
 *    scenarios.ts and test/eval/code-memory/corpus.ts (verbatim), plus
 *    held-out out-of-lexicon EN and RU sentences (the lane's whole
 *    point — none of their verbs are in the state-verb lexicon);
 *  - negatives: the intention/negation/hypothetical turns and guard
 *    fixtures from the same corpora and test/state-verb-harvest
 *    .unit-spec.ts, the corpora's non-transition prose, and held-out
 *    hard negatives ("almost sold", "about to part with").
 *
 * Scoring: item-level. An item is ACCEPTED when any candidate clause
 * clears (completed_* class, score ≥ floor, margin ≥ margin gate).
 *  - precision/recall (lenient): accepted & gold≠none / accepted&none;
 *  - class-strict TP additionally requires an accepted class ∈ gold
 *    (coding transitions carry the full completed set — the consumer
 *    acquire/dispose/change taxonomy does not map onto merges/bumps);
 *  - per-class P/R over single-gold items + all negatives.
 * Selection rule (precision-first, per the wiring PR): maximize
 * precision subject to recall ≥ 0.8; ties → higher recall, then the
 * stricter floor, then the stricter margin.
 */
import { BgeM3EmbedderProvider } from '../../../src/ai/embedder/bge-m3-embedder.provider';
import { declaredSpace } from '../../../src/ai/embedder/embedding-space';
import {
  createTransitionClassifier,
  type TransitionClass,
  type TransitionVerdict,
} from '../../../src/ai/extractor-internals/transition-classifier';
import { findHarvestCandidates } from '../../../src/ai/extractor-internals/transition-harvest';

type Completed = 'completed_acquire' | 'completed_dispose' | 'completed_change';
const ACQ: Completed = 'completed_acquire';
const DIS: Completed = 'completed_dispose';
const CHG: Completed = 'completed_change';
const ANY: Completed[] = [ACQ, DIS, CHG];

interface Item {
  id: string;
  /** Source: scenario/turn id, corpus conversation, or 'held-out'. */
  src: string;
  text: string;
  /** Acceptable completed classes; 'none' = must NOT emit. */
  gold: Completed[] | 'none';
}

const POSITIVES: Item[] = [
  // ── state-transitions corpus (verbatim turns) ─────────────────────
  {
    id: 'p01',
    src: 's01a',
    text: "I bought a Kawasaki Ninja on Saturday — it's registered to me.",
    gold: [ACQ],
  },
  { id: 'p02', src: 's01b', text: 'I sold the Kawasaki today; no bike anymore.', gold: [DIS] },
  {
    id: 'p03',
    src: 's02b',
    text: 'I replaced my laptop today: my work laptop is now a MacBook Pro, and the ThinkPad went back to IT.',
    gold: [CHG, DIS],
  },
  {
    id: 'p04',
    src: 's03a',
    text: 'I joined the chess club today; sessions are on Mondays.',
    gold: [ACQ],
  },
  {
    id: 'p05',
    src: 's03b',
    text: 'I quit the chess club today; Mondays got too busy at work.',
    gold: [DIS],
  },
  {
    id: 'p06',
    src: 's03c',
    text: 'I rejoined the chess club today — they moved sessions to Thursdays, so I am a member again.',
    gold: [ACQ, CHG],
  },
  {
    id: 'p07',
    src: 's04a',
    text: 'Turns out I actually cancelled my Spotify subscription back on August 1st.',
    gold: [DIS],
  },
  {
    id: 'p08',
    src: 's05a',
    text: 'I own a drone — a DJI Mavic 3 I bought last spring; I fly it most weekends.',
    gold: [ACQ],
  },
  { id: 'p09', src: 's08b', text: 'Moved my place of residence to Porto this week.', gold: [CHG] },
  {
    id: 'p10',
    src: 's09a',
    text: 'My brother Boris got a company car from his employer.',
    gold: [ACQ],
  },
  {
    id: 'p11',
    src: 's09b',
    text: 'Boris returned the company car when he switched jobs.',
    gold: [DIS, CHG],
  },
  {
    id: 'p12',
    src: 's10a',
    text: 'Signed up for the standing desk trial this morning.',
    gold: [ACQ],
  },
  {
    id: 'p13',
    src: 's10b',
    text: 'Returned the standing desk by evening — hurt my back.',
    gold: [DIS],
  },
  { id: 'p14', src: 's11b', text: 'Sold the Canon R6; the Fuji stays.', gold: [DIS] },
  // ── code-memory corpus (verbatim turns; consumer taxonomy does not
  //    map onto coding transitions, so any completed class counts) ───
  {
    id: 'p15',
    src: 'cm mixed/1',
    text: 'We merged PR #212 in acme-api — it lands the queue-relay cutover for outbound webhooks.',
    gold: ANY,
  },
  {
    id: 'p16',
    src: 'cm mixed/2',
    text: 'We reverted PR #212 this morning; the cutover doubled webhook latency for the EU tenants.',
    gold: ANY,
  },
  {
    id: 'p17',
    src: 'cm flags/5',
    text: 'We enabled ACME_RETRY_QUEUE in prod today; its default is now 1 for every acme-api tenant.',
    gold: ANY,
  },
  {
    id: 'p18',
    src: 'cm deps/2',
    text: 'We bumped redis-client to 2.0.0 in acme-api — the new cluster API is required by the retry queue.',
    gold: ANY,
  },
  {
    id: 'p19',
    src: 'cm flags/1',
    text: 'We introduced the ACME_RETRY_QUEUE flag in acme-api; it ships disabled and its default stays 0 until the queue is proven.',
    gold: ANY,
  },
  {
    id: 'p20',
    src: 'cm decision/5',
    text: 'Update: we walked the single-dispatcher decision back — outbound webhooks in acme-api now go through the managed queue relay in src/gateway/queue-relay.ts.',
    gold: ANY,
  },
  // ── held-out EN, out-of-lexicon verbs (the lane's whole point) ────
  { id: 'p21', src: 'held-out', text: 'She parted with her old laptop yesterday.', gold: [DIS] },
  {
    id: 'p22',
    src: 'held-out',
    text: 'He handed over the keys to the new tenant this morning.',
    gold: [DIS],
  },
  { id: 'p23', src: 'held-out', text: 'We rehomed our parrot last month.', gold: [DIS] },
  { id: 'p24', src: 'held-out', text: 'She enrolled in the pottery course.', gold: [ACQ] },
  { id: 'p25', src: 'held-out', text: 'He offloaded his crypto holdings in January.', gold: [DIS] },
  { id: 'p26', src: 'held-out', text: 'They relocated the office to Kraków.', gold: [CHG] },
  {
    id: 'p27',
    src: 'held-out',
    text: 'I traded in my old phone for the new model.',
    gold: [DIS, CHG],
  },
  // ── RU (bounded RU candidate path + multilingual prototypes) ──────
  { id: 'p28', src: 'held-out ru', text: 'Я продал мотоцикл вчера.', gold: [DIS] },
  { id: 'p29', src: 'held-out ru', text: 'Я купил новый велосипед в субботу.', gold: [ACQ] },
  { id: 'p30', src: 'held-out ru', text: 'Мы переехали в Ригу в марте.', gold: [CHG] },
  { id: 'p31', src: 'held-out ru', text: 'Я избавился от старого дивана.', gold: [DIS] },
  { id: 'p32', src: 'held-out ru', text: 'Сергей уволился с работы в пятницу.', gold: [DIS, CHG] },
  { id: 'p33', src: 'held-out ru', text: 'Оля вышла из книжного клуба в мае.', gold: [DIS] },
];

const NEGATIVES: Item[] = [
  // ── state-transitions corpus: guards + non-transition prose ───────
  {
    id: 'n01',
    src: 's05b',
    text: "I'm thinking about selling my drone, maybe next month.",
    gold: 'none',
  },
  {
    id: 'n02',
    src: 's05b',
    text: 'No decision yet; I want to see what used Mavics go for first.',
    gold: 'none',
  },
  { id: 'n03', src: 's06a', text: 'I listed my apartment in Riga for sale today.', gold: 'none' },
  {
    id: 'n04',
    src: 's01a',
    text: 'Life log, 2026-08-03. Weekend update: there is a new vehicle in my life.',
    gold: 'none',
  },
  {
    id: 'n05',
    src: 's01a',
    text: 'The Ninja lives in the garage; I plan to ride it to work on dry days.',
    gold: 'none',
  },
  {
    id: 'n06',
    src: 's01b',
    text: 'The buyer picked it up this evening and the registration transfer is done.',
    gold: 'none',
  },
  {
    id: 'n07',
    src: 's04a',
    text: 'So since the start of the month I have had no music subscription at all.',
    gold: 'none',
  },
  {
    id: 'n08',
    src: 's07a',
    text: 'The office lease runs until December 2026. That is what our signed contract copy says.',
    gold: 'none',
  },
  {
    id: 'n09',
    src: 's07b',
    text: 'I have not reconciled the two dates yet; someone is wrong and I need the original lease.',
    gold: 'none',
  },
  { id: 'n10', src: 's08a', text: 'My home city is Lisbon now.', gold: 'none' },
  {
    id: 'n11',
    src: 's08b',
    text: 'The Lisbon chapter is closed; from now on Porto is where I live.',
    gold: 'none',
  },
  {
    id: 'n12',
    src: 's02a',
    text: 'My work laptop is a ThinkPad X1 Carbon; it is the machine I do everything on.',
    gold: 'none',
  },
  // ── code-memory corpus: voiced plans + non-transition prose ───────
  {
    id: 'n13',
    src: 'cm mixed/3',
    text: 'We should probably enable ACME_STRICT_MODE for acme-api next quarter; nobody has measured the blast radius yet.',
    gold: 'none',
  },
  {
    id: 'n14',
    src: 'cm mixed/4',
    text: 'For the record, we have not enabled ACME_STRICT_MODE anywhere in acme-api.',
    gold: 'none',
  },
  {
    id: 'n15',
    src: 'cm mixed/5',
    text: 'Postmortem for Friday: the acme-api worker pool ran out of file descriptors because orphan webhook sockets piled up unclosed.',
    gold: 'none',
  },
  {
    id: 'n16',
    src: 'cm flags/2',
    text: 'The gateway metrics endpoint in acme-api listens on port 9187.',
    gold: 'none',
  },
  {
    id: 'n17',
    src: 'cm flags/3',
    text: 'acme-api throttles /v1/webhooks at 120 requests per minute.',
    gold: 'none',
  },
  {
    id: 'n18',
    src: 'cm deps/3',
    text: 'Priya owns src/gateway in acme-api, including the webhook dispatcher and the queue relay.',
    gold: 'none',
  },
  {
    id: 'n19',
    src: 'cm deps/4',
    text: 'Gotcha with redis-client 2.0.0 in acme-api: SCAN cursors are strings now, and comparing them to zero makes the loop silently never terminate.',
    gold: 'none',
  },
  {
    id: 'n20',
    src: 'cm decision/1',
    text: 'We decided to route every outbound webhook in acme-api through src/gateway/webhook-dispatcher.ts — one dispatch path instead of six ad-hoc fetch calls.',
    gold: 'none',
  },
  {
    id: 'n21',
    src: 'cm decision/2',
    text: 'The reason: retry and signing logic had drifted between the six webhook call-sites, and two of them never signed payloads at all.',
    gold: 'none',
  },
  {
    id: 'n22',
    src: 'cm deps/1',
    text: 'acme-api pins redis-client at 1.2.0; the pin lives in the root package.json.',
    gold: 'none',
  },
  {
    id: 'n23',
    src: 'cm eval/k-turn',
    text: 'Cap the replay window at 48 hours; longer windows re-deliver acknowledged webhooks.',
    gold: 'none',
  },
  // ── state-verb guard fixtures (test/state-verb-harvest.unit-spec) ─
  { id: 'n24', src: 'sv guard', text: "I haven't sold the bike", gold: 'none' },
  { id: 'n25', src: 'sv guard', text: 'I will quit next month', gold: 'none' },
  { id: 'n26', src: 'sv guard', text: 'we discussed whether he might leave', gold: 'none' },
  { id: 'n27', src: 'sv guard', text: 'I never returned the standing desk', gold: 'none' },
  { id: 'n28', src: 'sv guard', text: 'I am planning to quit the gym', gold: 'none' },
  { id: 'n29', src: 'sv guard', text: "We didn't merge the release branch.", gold: 'none' },
  {
    id: 'n30',
    src: 'sv guard',
    text: 'We might revert the cutover if latency regresses.',
    gold: 'none',
  },
  { id: 'n31', src: 'sv guard', text: 'We are about to release v2.4.', gold: 'none' },
  { id: 'n32', src: 'sv guard', text: 'PR #431 was merged.', gold: 'none' },
  { id: 'n33', src: 'sv guard', text: 'The flag was enabled.', gold: 'none' },
  {
    id: 'n34',
    src: 'sv guard',
    text: 'We are considering disabling the retry sweep.',
    gold: 'none',
  },
  // ── held-out hard negatives ───────────────────────────────────────
  { id: 'n35', src: 'held-out', text: 'He almost sold the boat.', gold: 'none' },
  { id: 'n36', src: 'held-out', text: 'She was about to part with her old laptop.', gold: 'none' },
  // ── RU guards + noise ─────────────────────────────────────────────
  { id: 'n37', src: 'held-out ru', text: 'Я не продал мотоцикл.', gold: 'none' },
  { id: 'n38', src: 'held-out ru', text: 'Я собираюсь продать машину.', gold: 'none' },
  { id: 'n39', src: 'held-out ru', text: 'Я подумываю продать мотоцикл.', gold: 'none' },
  { id: 'n40', src: 'held-out ru', text: 'Созвон прошёл неплохо.', gold: 'none' },
  { id: 'n41', src: 'held-out ru', text: 'Если бы я продал машину, я бы жалел.', gold: 'none' },
  { id: 'n42', src: 'held-out ru', text: 'У меня был мотоцикл.', gold: 'none' },
  { id: 'n43', src: 'held-out ru', text: 'Встреча прошла хорошо.', gold: 'none' },
];

const FLOORS = [0.4, 0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7];
const MARGINS = [0, 0.002, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08, 0.12];

const COMPLETED = new Set<TransitionClass>([ACQ, DIS, CHG]);

interface Scored {
  item: Item;
  verdicts: TransitionVerdict[];
}

function accepted(v: TransitionVerdict, floor: number, margin: number): boolean {
  return COMPLETED.has(v.cls) && v.score >= floor && v.margin >= margin;
}

interface GridPoint {
  floor: number;
  margin: number;
  tp: number;
  tpStrict: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  strictRecall: number;
}

function evaluate(scored: Scored[], floor: number, margin: number): GridPoint {
  let tp = 0;
  let tpStrict = 0;
  let fp = 0;
  let fn = 0;
  for (const { item, verdicts } of scored) {
    const acc = verdicts.filter((v) => accepted(v, floor, margin));
    if (item.gold === 'none') {
      if (acc.length > 0) fp++;
    } else if (acc.length === 0) {
      fn++;
    } else {
      tp++;
      if (acc.some((v) => (item.gold as Completed[]).includes(v.cls as Completed))) tpStrict++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const strictRecall = tp + fn === 0 ? 1 : tpStrict / (tp + fn);
  return { floor, margin, tp, tpStrict, fp, fn, precision, recall, strictRecall };
}

function perClass(scored: Scored[], floor: number, margin: number): string[] {
  const rows: string[] = [];
  for (const cls of [ACQ, DIS, CHG]) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { item, verdicts } of scored) {
      const accCls = verdicts.some((v) => v.cls === cls && accepted(v, floor, margin));
      const goldCls = item.gold !== 'none' && item.gold.length === 1 && item.gold[0] === cls;
      if (accCls && item.gold !== 'none' && item.gold.includes(cls)) tp++;
      else if (accCls && (item.gold === 'none' || !item.gold.includes(cls))) fp++;
      if (goldCls && !accCls) fn++;
    }
    const p = tp + fp === 0 ? 1 : tp / (tp + fp);
    const r = tp + fn === 0 ? 1 : tp / (tp + fn);
    rows.push(`| ${cls} | ${p.toFixed(3)} | ${r.toFixed(3)} | ${tp} | ${fp} | ${fn} |`);
  }
  return rows;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // The declared space — the harness calibrates against the real
  // production embedder, so it must use the production model + width.
  const provider = new BgeM3EmbedderProvider({
    space: declaredSpace('bge-m3'),
    concurrency: 2,
    useWorker: false,
  });
  await provider.warmup();
  if (!provider.isReady()) {
    console.error(
      'BGE-M3 failed to load. The harness calibrates against the real ' +
        'production embedder only — a stub-calibrated threshold would be ' +
        'fiction. Ensure @xenova/transformers can reach its cache (first ' +
        'run downloads ~230 MB, free) and retry.',
    );
    process.exit(1);
  }
  const classifier = createTransitionClassifier(async (texts) => {
    const out: number[][] = [];
    for (const t of texts) out.push(await provider.embed(t));
    return out;
  });

  const items = [...POSITIVES, ...NEGATIVES];
  const scored: Scored[] = [];
  for (const item of items) {
    const candidates = findHarvestCandidates(item.text);
    const verdicts =
      candidates.length > 0 ? await classifier.classify(candidates.map((c) => c.clause)) : [];
    scored.push({ item, verdicts });
  }
  console.log(
    `\nembedded ${items.length} items in ${Date.now() - t0}ms ` +
      `(${POSITIVES.length} positives, ${NEGATIVES.length} negatives)\n`,
  );

  // Deterministic pre-classifier misses (no candidate survived
  // morphology/guards) — thresholds cannot recover these.
  for (const s of scored) {
    if (s.item.gold !== 'none' && s.verdicts.length === 0) {
      console.log(`candidate-stage MISS: ${s.item.id} (${s.item.src}) ${s.item.text}`);
    }
  }

  console.log('\n| floor | margin | P | R | strictR | TP | FP | FN |');
  console.log('|---|---|---|---|---|---|---|---|');
  const grid: GridPoint[] = [];
  for (const floor of FLOORS) {
    for (const margin of MARGINS) {
      const g = evaluate(scored, floor, margin);
      grid.push(g);
      console.log(
        `| ${floor.toFixed(2)} | ${margin.toFixed(4)} | ${g.precision.toFixed(3)} | ` +
          `${g.recall.toFixed(3)} | ${g.strictRecall.toFixed(3)} | ${g.tp} | ${g.fp} | ${g.fn} |`,
      );
    }
  }

  const eligible = grid.filter((g) => g.recall >= 0.8);
  eligible.sort(
    (a, b) =>
      b.precision - a.precision || b.recall - a.recall || b.floor - a.floor || b.margin - a.margin,
  );
  const best = eligible[0];
  if (!best) {
    console.log('\nNO grid point reaches recall >= 0.8 — inspect the candidate-stage misses.');
    return;
  }
  console.log(
    `\nCHOSEN (max precision s.t. recall >= 0.8): floor=${best.floor} margin=${best.margin} ` +
      `P=${best.precision.toFixed(3)} R=${best.recall.toFixed(3)} strictR=${best.strictRecall.toFixed(3)}`,
  );

  console.log('\nPer-class at the chosen point (single-gold items + all negatives):');
  console.log('| class | P | R | TP | FP | FN |');
  console.log('|---|---|---|---|---|---|');
  for (const row of perClass(scored, best.floor, best.margin)) console.log(row);

  console.log('\nErrors at the chosen point:');
  for (const { item, verdicts } of scored) {
    const acc = verdicts.filter((v) => accepted(v, best.floor, best.margin));
    const top = verdicts
      .map((v) => `${v.cls}@${v.score.toFixed(3)}/m${v.margin.toFixed(3)}`)
      .join(', ');
    if (item.gold === 'none' && acc.length > 0) {
      console.log(`  FP ${item.id} (${item.src}) "${item.text}" → ${top}`);
    } else if (item.gold !== 'none' && acc.length === 0) {
      console.log(`  FN ${item.id} (${item.src}) "${item.text}" → ${top || 'no candidates'}`);
    }
  }
}

void main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error('calibration failed:', e);
    process.exit(1);
  },
);
