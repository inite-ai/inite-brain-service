/**
 * The model interface the multilingual matrix runner talks to, plus its
 * two implementations and the SPEND GATE that chooses between them.
 *
 *   - StubModel — deterministic, synthetic, NO model calls. Derives its
 *     predictions from the case's own gold, optionally perturbed. This is
 *     the ONLY implementation the unit/CI path ever constructs.
 *   - RealModel — the live path that would call a real model. It is
 *     constructed ONLY when `MULTILINGUAL_EVAL_LIVE` is set AND a real API
 *     key is present, and even then its `predict` throws in Tier 0 (the
 *     live wiring is intentionally unbuilt). No code path here can make a
 *     paid call.
 *
 * `createMultilingualModel` is the single entry point: default env → Stub;
 * live flag without a key → refuse (throw); live flag WITH a key → Real.
 */

import type {
  LanguageCode,
  MultilingualCase,
  MultilingualPrediction,
} from '../../../src/eval/types';
import { detectLanguage } from './script-detect';

export interface MultilingualModel {
  readonly kind: 'stub' | 'real';
  predict(testCase: MultilingualCase): MultilingualPrediction;
}

export type StubMode = 'perfect' | 'degraded';

export interface StubModelOptions {
  /** 'perfect' echoes gold (metrics ≈ ideal); 'degraded' perturbs every
   *  dimension so the runner's metrics visibly drop — the two together
   *  prove the scorers are actually wired to the predictions. */
  mode?: StubMode;
}

/** Canned single-language answer strings the stub emits, one per language.
 *  Chosen so the deterministic detector classifies each correctly. */
const ANSWER_SAMPLES: Record<LanguageCode, string> = {
  en: 'The head of engineering is our CTO.',
  ru: 'Технический директор руководит инженерным отделом.',
  de: 'Der Leiter der Technik ist unser CTO.',
  es: 'El director de ingeniería es nuestro CTO.',
  zh: '技术总监负责工程部门。',
  ar: 'مدير الهندسة هو المسؤول عن القسم.',
  hi: 'इंजीनियरिंग प्रमुख हमारे सीटीओ हैं।',
};

function addOneDay(isoDay: string): string {
  const t = Date.parse(isoDay);
  if (Number.isNaN(t)) return isoDay;
  return new Date(t + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class StubModel implements MultilingualModel {
  readonly kind = 'stub' as const;
  private readonly mode: StubMode;

  constructor(opts: StubModelOptions = {}) {
    this.mode = opts.mode ?? 'perfect';
  }

  predict(testCase: MultilingualCase): MultilingualPrediction {
    const g = testCase.gold;
    const degraded = this.mode === 'degraded';

    let out: MultilingualPrediction = {};

    if (g.retrieval) {
      const others = g.retrieval.corpusRefs.filter((r) => r !== g.retrieval!.goldRef);
      const rankedRefs = degraded
        ? [...others, g.retrieval.goldRef] // gold pushed to the back
        : [g.retrieval.goldRef, ...others]; // gold on top
      out = { ...out, retrieval: { rankedRefs } };
    }

    if (g.extraction) {
      const facts = degraded
        ? [...g.extraction.goldFacts.slice(0, -1), 'entity_type=WRONG']
        : [...g.extraction.goldFacts];
      out = { ...out, extraction: { facts } };
    }

    if (g.linking) {
      const gold = g.linking.goldEntity;
      const linkedRefs = g.linking.surfaces.map((_, i) =>
        degraded && i > 0 ? 'cross.__wrong' : gold,
      );
      const nodeIds = g.linking.surfaces.map((_, i) => (degraded ? `n${i}` : 'n0'));
      out = { ...out, linking: { linkedRefs, nodeIds } };
    }

    if (g.temporal) {
      const predictedDate = degraded ? addOneDay(g.temporal.goldDate) : g.temporal.goldDate;
      out = { ...out, temporal: { predictedDate } };
    }

    if (g.conflict) {
      out = { ...out, conflict: { label: degraded ? 'no_conflict' : g.conflict.goldLabel } };
    }

    if (g.lane) {
      out = { ...out, lane: { label: degraded ? 'default' : g.lane.goldLabel } };
    }

    if (g.answerLang) {
      const intended = g.answerLang.intended;
      const lang: LanguageCode = degraded ? (intended === 'en' ? 'ru' : 'en') : intended;
      const text = ANSWER_SAMPLES[lang];
      out = { ...out, answer: { text, langDetected: detectLanguage(text).lang } };
    }

    if (g.abstention) {
      const should = g.abstention.shouldAnswer;
      // Perfect: answer answerable / abstain on false-premise, confidence
      // tracks answerability. Degraded: INVERT the decision (over-reject +
      // hallucinate at once) and pin confidence flat (miscalibrated).
      const abstained = degraded ? should : !should;
      const confidence = degraded ? 0.9 : should ? 0.95 : 0.08;
      out = { ...out, abstention: { abstained, confidence } };
    }

    if (g.telemetry) {
      out = { ...out, telemetry: g.telemetry.map((s) => ({ ...s })) };
    }

    return out;
  }
}

/**
 * The live implementation. Deliberately inert in Tier 0: it can be
 * CONSTRUCTED (only through the gated factory below) but its `predict`
 * throws, so no paid call is reachable from this codebase. Tier 1 fills
 * in the real model wiring behind the same gate.
 */
export class RealModel implements MultilingualModel {
  readonly kind = 'real' as const;

  predict(_testCase: MultilingualCase): MultilingualPrediction {
    throw new Error(
      'RealModel.predict is not implemented in Tier 0. The live multilingual eval ' +
        'calls a paid model and is intentionally unbuilt; only StubModel runs in CI.',
    );
  }
}

/** Env surface the gate reads. Accepts process.env or a plain object. */
export type MultilingualModelEnv = Record<string, string | undefined>;

/** True only when the live flag is explicitly enabled. */
export function isLiveEvalEnabled(env: MultilingualModelEnv): boolean {
  const flag = (env.MULTILINGUAL_EVAL_LIVE ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * The single spend gate. Returns a StubModel unless BOTH the explicit
 * `MULTILINGUAL_EVAL_LIVE` flag AND a real API key are present. When the
 * flag is set but no key is available, it REFUSES (throws) rather than
 * silently degrading — so a half-configured live run can never quietly
 * fall back to something that might bill.
 */
export function createMultilingualModel(
  env: MultilingualModelEnv = process.env,
  opts: StubModelOptions = {},
): MultilingualModel {
  if (!isLiveEvalEnabled(env)) return new StubModel(opts);

  const hasRealKey = Boolean(
    (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) ||
    (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()),
  );
  if (!hasRealKey) {
    throw new Error(
      'MULTILINGUAL_EVAL_LIVE is set but no OPENAI_API_KEY / ANTHROPIC_API_KEY is present — ' +
        'refusing to construct a live model that could make a paid call.',
    );
  }
  return new RealModel();
}
