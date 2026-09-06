/**
 * Transition classifier stage (EXTRACTOR_TRANSITION_CLASSIFIER, stage 2
 * of 2 — the morphology stage lives in transition-morphology.ts).
 *
 * Embedding-prototype matching over candidate clauses: each clause is
 * embedded and cosine-compared against a fixed bank of short prototype
 * sentences per class; the verdict is the argmax class with its score
 * and the margin to the runner-up. No trained model, no lexicon, no
 * thresholds baked into the verdict — the CALLER applies thresholds
 * (see the exported calibration constants).
 *
 * Why prototypes and not a lexicon: the production embedder (BGE-M3)
 * is multilingual, so the classifier is language-agnostic BY
 * CONSTRUCTION — the bank carries EN and RU prototypes and any input
 * language the embedder handles lands in the same space. The
 * deterministic English lexicon lane (state-verb-harvest, parallel
 * branch) composes with this in a follow-up wiring PR: morphology
 * proposes clauses, the lexicon catches known verbs deterministically,
 * this stage generalizes to unlisted verbs and other languages.
 *
 * Pure module: no Nest/DI imports, no env reads. The embedder is
 * injected as a plain async function so unit tests stay offline.
 */

export type TransitionClass =
  'completed_acquire' | 'completed_dispose' | 'completed_change' | 'intention' | 'unrelated';

export interface TransitionVerdict {
  cls: TransitionClass;
  /** Max cosine similarity to the winning class's prototypes. */
  score: number;
  /** Gap between the winning class's score and the runner-up class's. */
  margin: number;
}

/** Batch embedder: one vector per input text, all the same dimension. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Stable class order — argmax ties break toward the earlier class. */
export const TRANSITION_CLASSES: readonly TransitionClass[] = [
  'completed_acquire',
  'completed_dispose',
  'completed_change',
  'intention',
  'unrelated',
];

/**
 * The prototype bank. Short, concrete, first/third-person sentences —
 * EN and RU per class (BGE-M3 is multilingual, so RU prototypes make
 * the classifier work on RU input for free; more languages are a
 * bank-only change). Exported for tests and for stand calibration.
 */
export const TRANSITION_PROTOTYPES: Readonly<Record<TransitionClass, readonly string[]>> = {
  completed_acquire: [
    'I bought a new laptop yesterday.',
    'He joined the chess team.',
    'We signed up for the service.',
    'She got a company car from her employer.',
    'Я купил новый ноутбук.',
    'Он вступил в клуб.',
    'Мы подписали контракт с новым поставщиком.',
    'Я получил ключи от квартиры.',
  ],
  completed_dispose: [
    'I sold my car last week.',
    'She quit the club.',
    'We returned the equipment.',
    'He cancelled his subscription.',
    'Я продал машину на прошлой неделе.',
    'Я больше не владею этой квартирой.',
    'Она вышла из клуба.',
    'Мы вернули оборудование продавцу.',
  ],
  completed_change: [
    'We moved to Berlin.',
    'They switched to PostgreSQL.',
    'I changed jobs in April.',
    'She renamed the company.',
    'Я переехал в другой город.',
    'Мы перешли на другой тариф.',
    'Он сменил работу этой весной.',
    'Компания переехала в новый офис.',
  ],
  intention: [
    'I am thinking about selling my car.',
    'We might switch vendors.',
    'I plan to quit next month.',
    'She wants to buy a house.',
    'He is considering leaving the company.',
    'Я подумываю продать машину.',
    'Я собираюсь купить велосипед.',
    'Мы, возможно, сменим поставщика.',
    'Она хочет вступить в клуб.',
  ],
  unrelated: [
    'The office is on the third floor.',
    'The meeting went well.',
    'I like working from home.',
    'The weather was great today.',
    'The report is due on Friday.',
    'Я люблю кофе.',
    'Офис находится на третьем этаже.',
    'Встреча прошла хорошо.',
    'Отчёт нужно сдать в пятницу.',
  ],
};

/**
 * Default margin gate: below this gap to the runner-up the verdict is
 * ambiguous and the caller abstains. CALIBRATED 2026-09-06 with the
 * real BGE-M3 embedder (Xenova/bge-m3 quantized ONNX, cls-pooled,
 * normalized — the production provider's own inference path) over the
 * wired candidate pipeline and a 76-item labeled set drawn from the
 * state-transition battery, the code-memory corpus, the state-verb
 * guard fixtures, and held-out out-of-lexicon EN + RU sentences —
 * see test/eval/transition-calibration/runner.ts (deterministic,
 * local-only; rerun with `pnpm eval:transition-calibration`).
 * Selection rule: maximize precision subject to recall >= 0.8; the
 * chosen point measured P=0.906 / R=0.879. BGE-M3 packs all five
 * classes' prototypes tightly, so real margins are tiny — gates above
 * ~0.01 collapse recall (0.01 already drops it below the 0.8 bound);
 * this near-zero gate only prunes coin-flip verdicts.
 */
export const TRANSITION_MARGIN_DEFAULT = 0.002;

/**
 * Default score floor: below this max-cosine the clause is too far
 * from every prototype to trust ANY class. Same calibration run as
 * TRANSITION_MARGIN_DEFAULT (P=0.906 / R=0.879 at floor 0.52,
 * margin 0.002). Positives cluster at ~0.55-0.85; the residual false
 * accepts (reported-speech "signed contract copy", result-state "have
 * had no music subscription") sit at 0.64-0.72 and are prototype-bank
 * gaps, not threshold errors — raising the floor past them costs more
 * recall than it buys precision (0.65/0.05 measures P=0.944 at
 * R=0.515).
 */
export const TRANSITION_SCORE_FLOOR = 0.52;

/** Cosine similarity; 0 for zero-norm vectors (never NaN). */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface TransitionClassifier {
  classify(clauses: string[]): Promise<TransitionVerdict[]>;
}

/**
 * Create a classifier over the injected embedder. The prototype bank is
 * embedded lazily ONCE and cached in the closure (one embed batch for
 * the whole bank, in TRANSITION_CLASSES order); each classify() call
 * embeds its input clauses as one batch. A failed bank embedding is NOT
 * cached — the next call retries.
 */
export function createTransitionClassifier(embed: EmbedFn): TransitionClassifier {
  const bankTexts = TRANSITION_CLASSES.flatMap((cls) => TRANSITION_PROTOTYPES[cls]);
  /** Per class: index range [from, to) into the flattened bank. */
  const ranges = new Map<TransitionClass, [number, number]>();
  {
    let at = 0;
    for (const cls of TRANSITION_CLASSES) {
      ranges.set(cls, [at, at + TRANSITION_PROTOTYPES[cls].length]);
      at += TRANSITION_PROTOTYPES[cls].length;
    }
  }
  let bankPromise: Promise<number[][]> | null = null;
  const bankVectors = (): Promise<number[][]> => {
    bankPromise ??= embed([...bankTexts]).catch((err: unknown) => {
      bankPromise = null; // do not cache the failure
      throw err;
    });
    return bankPromise;
  };

  return {
    async classify(clauses: string[]): Promise<TransitionVerdict[]> {
      if (clauses.length === 0) return [];
      const bank = await bankVectors();
      const inputs = await embed(clauses);
      return inputs.map((vec) => {
        let best: TransitionClass = TRANSITION_CLASSES[0]!;
        let bestScore = -Infinity;
        let runnerUp = -Infinity;
        for (const cls of TRANSITION_CLASSES) {
          const [from, to] = ranges.get(cls)!;
          let classMax = -Infinity;
          for (let i = from; i < to; i++) {
            const s = cosine(vec, bank[i] ?? []);
            if (s > classMax) classMax = s;
          }
          if (classMax > bestScore) {
            runnerUp = bestScore;
            bestScore = classMax;
            best = cls;
          } else if (classMax > runnerUp) {
            runnerUp = classMax;
          }
        }
        return {
          cls: best,
          score: bestScore,
          margin: runnerUp === -Infinity ? bestScore : bestScore - runnerUp,
        };
      });
    },
  };
}
