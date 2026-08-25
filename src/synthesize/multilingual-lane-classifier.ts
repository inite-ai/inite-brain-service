/**
 * Multilingual lane classifier (MULTILINGUAL_LANE_ROUTING) — Tier 4.
 *
 * A SEPARATE, language-agnostic multi-label classifier that AUGMENTS the
 * English-regex router (answer-router.ts) for the queries it returns
 * null/generic for. It is NOT the lens-suppression model: that governor is
 * subtractive (removes lanes from an active set); this one is a positive
 * nearest-centroid MATCH that proposes ONE lane for an otherwise-unrouted
 * query. It reuses only the shared cosine PRIMITIVE (common/vector-math),
 * exactly as lens-suppression does — same primitive, different model.
 *
 * The centroids are seeded from a small in-repo labeled exemplar set
 * (LANE_EXEMPLARS), embedded once at classify time and cached by the
 * service — no paid training data, no migration, no DB. Multilingual
 * embedders (OpenAI text-embedding-3-*, BGE-M3) place a non-English query
 * near its same-lane exemplars regardless of language, so the regex router's
 * blind spot (its lexicons are English) is covered without per-language
 * rules.
 *
 * Abstain-first by construction: a nearest match below the cosine floor, an
 * ambiguous top-2 (margin below the floor), an empty/dimension-mismatched
 * model, or an empty query embedding all return `null` — the generic path,
 * i.e. today's behavior. It can therefore only ADD a route where the regex
 * router found none; it never overrides a regex hit (the caller only invokes
 * it on a null route) and never emits an inactive or non-routable lane.
 *
 * Pure module — no DI, no IO, no env. The service (…​.service.ts) owns the
 * embedder call + centroid cache; the flag is resolved in retrieval-profile
 * (profile.multilingualLaneRouting) and checked at the synthesize boundary.
 */

import type { LaneId } from '../search/retrieval-profile';
import { cosineSimilarity } from '../common/vector-math';

/**
 * The lanes the classifier may propose — exactly the QUERY-ROUTABLE lanes of
 * the registry (those with a `detect` lexicon). The evidence-conditional
 * lanes (contradiction / recency / instruction / strategy) are never routed
 * from the query text, so the classifier must never emit them. `ordering` is
 * folded into `enumeration` in the registry (ENUMERATION_PATTERNS ⊇
 * ORDERING_PATTERNS), so it is not a separate class here.
 */
export const CLASSIFIER_LANES = [
  'temporal',
  'enumeration',
  'preference',
  'summary',
] as const satisfies readonly LaneId[];

export type ClassifierLane = (typeof CLASSIFIER_LANES)[number];

/**
 * In-repo labeled exemplar set — short, natural queries per lane across the
 * Tier 1-3 target languages (en, ru, es, fr, de, pt, it, zh, ja, ko, ar,
 * hi). Deliberately small and paraphrase-diverse: the centroid is a mean, so
 * a handful of on-topic phrasings per language localizes the lane well
 * without paid data. Add exemplars here — no migration, no retraining.
 */
export const LANE_EXEMPLARS: Record<ClassifierLane, readonly string[]> = {
  temporal: [
    'how long ago did I start learning the piano',
    'when did I move to Berlin',
    'how many days since I quit smoking',
    'сколько времени прошло с моего переезда',
    'когда я в последний раз был у врача',
    'combien de temps depuis mon déménagement',
    'quand ai-je commencé ce travail',
    'vor wie langer zeit habe ich angefangen',
    'hace cuánto tiempo empecé a correr',
    'há quanto tempo eu moro aqui',
    'da quanto tempo lavoro qui',
    '我上次去看医生是多久以前',
    'ピアノを始めてからどれくらい経ちましたか',
    '내가 이사한 지 얼마나 됐어',
    'منذ متى بدأت تعلم اللغة',
    'मैंने कितने दिन पहले शुरू किया था',
  ],
  enumeration: [
    'list all the cities I have visited',
    'how many books did I read this year',
    'name every project I worked on',
    'перечисли все места, где я был',
    'сколько всего курсов я прошёл',
    'liste tous les restaurants que j’ai aimés',
    'combien de fois suis-je allé à la gym',
    'zähle alle länder auf die ich besucht habe',
    'enumera todos los libros que leí',
    'quantos filmes eu assisti',
    'elenca tutti i corsi che ho seguito',
    '列出我去过的所有城市',
    '私が訪れた都市をすべて挙げて',
    '내가 방문한 도시를 모두 나열해줘',
    'اذكر كل الأماكن التي زرتها',
    'मैंने कौन कौन सी किताबें पढ़ीं सब बताओ',
  ],
  preference: [
    'what restaurant should I try tonight',
    'can you recommend a book for me',
    'suggest a movie I would enjoy',
    'что мне посмотреть сегодня вечером',
    'посоветуй мне ресторан',
    'peux-tu me recommander un livre',
    'que devrais-je cuisiner ce soir',
    'welches buch solltest du mir empfehlen',
    'qué película me recomiendas',
    'o que você me recomenda para o jantar',
    'cosa mi consigli di guardare',
    '给我推荐一本书',
    'おすすめの映画を教えて',
    '나에게 어울리는 책 추천해줘',
    'بماذا تنصحني أن أشاهد الليلة',
    'मुझे कौन सी फिल्म देखनी चाहिए सुझाव दो',
  ],
  summary: [
    'summarize how my fitness has progressed',
    'give me an overview of my career so far',
    'how has my relationship with my sister evolved',
    'подведи итог моего года',
    'как менялось моё здоровье со временем',
    'résume l’évolution de mon projet',
    'donne-moi un aperçu de mes progrès',
    'fasse meine fortschritte zusammen',
    'resume cómo ha evolucionado mi carrera',
    'faça um resumo do meu progresso',
    'riassumi come è andato il mio anno',
    '总结一下我这一年的变化',
    '私のキャリアのこれまでを要約して',
    '내 경력이 어떻게 발전했는지 요약해줘',
    'لخّص لي تطوّر مسيرتي المهنية',
    'मेरी प्रगति का सारांश दो',
  ],
};

/** One fitted lane class: the mean of its embedded exemplars. */
export interface LaneCentroid {
  lane: ClassifierLane;
  centroid: number[];
  /** Exemplars that fed the centroid (0 ⇒ unusable, skipped). */
  sampleCount: number;
}

export type LaneClassifierModel = readonly LaneCentroid[];

/** Classifier outcome (control flow + telemetry label). */
export type LaneClassifyOutcome =
  'classified' | 'abstain_no_model' | 'abstain_low_confidence' | 'abstain_ambiguous';

export interface LaneClassification {
  /** The proposed lane, or null for every abstain outcome. */
  lane: ClassifierLane | null;
  outcome: LaneClassifyOutcome;
  /** Active-and-routable lanes ranked by cosine (desc); [] for no_model. */
  ranked: ReadonlyArray<{ lane: ClassifierLane; cosine: number }>;
}

/**
 * Conservative, UNVALIDATED defaults (default-off feature; abstain-safe, so
 * erring high just declines more often → today's behavior). The cosine floor
 * rejects unrelated queries; the margin floor declines an ambiguous top-2
 * rather than guess between two near-tied lanes.
 */
export const LANE_CLASSIFIER_MIN_COSINE = 0.3;
export const LANE_CLASSIFIER_MIN_MARGIN = 0.02;

/**
 * Build per-lane centroids (mean vector) from embedded exemplars. Cosine
 * normalizes magnitude, so the un-normalized mean is a fine centroid. A lane
 * with no non-empty exemplar embedding is dropped (sampleCount 0).
 */
export function buildLaneCentroids(
  embeddingsByLane: ReadonlyMap<ClassifierLane, number[][]>,
): LaneClassifierModel {
  const out: LaneCentroid[] = [];
  for (const lane of CLASSIFIER_LANES) {
    const vecs = (embeddingsByLane.get(lane) ?? []).filter((v) => v.length > 0);
    if (vecs.length === 0) continue;
    const dim = vecs[0]!.length;
    const sum = new Array<number>(dim).fill(0);
    let counted = 0;
    for (const v of vecs) {
      if (v.length !== dim) continue; // never average across dimensions
      for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
      counted++;
    }
    if (counted === 0) continue;
    out.push({
      lane,
      centroid: sum.map((s) => s / counted),
      sampleCount: counted,
    });
  }
  return out;
}

/**
 * The pure classification decision. Nearest-centroid over the classes that
 * are BOTH active (in `activeLanes`) and dimension-compatible with the query
 * embedding. Abstains (lane: null) on an empty/incompatible model, a nearest
 * cosine below `minCosine`, or a top-2 margin below `minMargin`. Never emits
 * a lane outside `activeLanes` or outside CLASSIFIER_LANES.
 */
export function classifyLane(args: {
  model: LaneClassifierModel;
  queryEmbedding: number[];
  activeLanes: ReadonlySet<LaneId>;
  minCosine: number;
  minMargin: number;
}): LaneClassification {
  const { model, queryEmbedding, activeLanes, minCosine, minMargin } = args;
  if (queryEmbedding.length === 0) {
    return { lane: null, outcome: 'abstain_no_model', ranked: [] };
  }
  const usable = model.filter(
    (c) =>
      c.sampleCount > 0 && c.centroid.length === queryEmbedding.length && activeLanes.has(c.lane),
  );
  if (usable.length === 0) {
    return { lane: null, outcome: 'abstain_no_model', ranked: [] };
  }
  const ranked = usable
    .map((c) => ({ lane: c.lane, cosine: cosineSimilarity(queryEmbedding, c.centroid) }))
    .sort((a, b) => b.cosine - a.cosine);
  const top = ranked[0]!;
  if (top.cosine < minCosine) {
    return { lane: null, outcome: 'abstain_low_confidence', ranked };
  }
  const second = ranked[1];
  if (second && top.cosine - second.cosine < minMargin) {
    return { lane: null, outcome: 'abstain_ambiguous', ranked };
  }
  return { lane: top.lane, outcome: 'classified', ranked };
}
