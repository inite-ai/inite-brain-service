import type { Scenario, SetupMentionStep } from '../types';

/**
 * Content-domain extraction-recall scenario.
 *
 * Tests that ExtractorService correctly surfaces v1.1 content-domain
 * predicates from a brand-briefing paragraph (BRUP-03: recall@1 ≥ 0.90).
 *
 * Why TypeScript not JSON: SetupMentionStep (with expectedPredicates) is a
 * TypeScript-only construct. The JSON directory loader only supports
 * fact | retract | forgetEntities — mention steps are unsupported in the
 * JSON shape (see test/eval/loaders/json-directory.loader.ts and
 * RESEARCH.md § Pitfall 3).
 *
 * Entity narrative is consistent with test/eval/fixtures/content-brand-acme.json
 * (same acme_beverages entity in content vertical) so a reviewer can read
 * both side-by-side.
 */

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Brand-briefing text. Contains unambiguous signals for exactly 7 distinct
 * content-domain predicates. Calibrated per 10-EXTRACTION-SCENARIO-SPEC.md.
 * Do NOT add product_description, narrative_pillar, or reference_example
 * signals — those 3 predicates are intentionally absent from expectedPredicates
 * because the text carries no unambiguous signal for them.
 */
const BRAND_BRIEFING_TEXT = `Acme Beverages is a small-batch functional-drinks brand built by indie founders for indie founders. Our brand voice is bold, irreverent, and warmly human — never corporate. We embody the Outlaw archetype: we challenge industry conventions and refuse to take ourselves too seriously. Our tone is conversational, punchy, and free of jargon; we avoid passive voice and we don't hedge. Our audience breaks into two segments: indie SaaS founders aged 25-40 in EU and North America, and content creators building audiences on LinkedIn and YouTube. Every piece of content we publish must lead with a customer result or data point, not a feature. Our customers feel a deep tension: they want sustained focus without the jitteriness of high-caffeine drinks. We never use the word 'revolutionary' in any content piece, and we don't claim health benefits without citing a study.`;

/**
 * Content brand extraction scenario.
 *
 * One SetupMentionStep with a 7-predicate expectedPredicates array.
 * The harness computes predicateRecall = (predicates_observed ∩ expected) /
 * expected.length — must be ≥ 0.90 per BRUP-03. With 7 expected predicates,
 * all 7 must be surfaced (0.857 < 0.90 threshold; only 1.0 passes).
 */
export const contentScenarios: Scenario[] = [
  {
    id: 'content-brand-extraction',
    vertical: 'cross',
    description:
      'Content-domain brand briefing extraction. Validates that ExtractorService surfaces 7 distinct content-domain predicate types from a prose brand-briefing paragraph. BRUP-03: predicateRecall ≥ 0.90.',
    setup: [
      {
        kind: 'mention',
        text: BRAND_BRIEFING_TEXT,
        contextRef: {
          vertical: 'content',
          conversationId: 'kb:acme:briefing',
          messageId: 'acme:briefing:001',
        },
        knownEntities: [
          { vertical: 'content', id: 'acme_beverages', role: 'subject' },
        ],
        emittedAt: ISO('2026-05-18'),
        /**
         * 7 distinct predicate types the extractor must surface.
         * Note: target_audience_segment appears twice in the text (two segments)
         * but predicateRecall measures distinct predicate types, not fact counts —
         * two target_audience_segment extractions count as one toward recall.
         *
         * Intentionally absent: product_description, narrative_pillar,
         * reference_example — text carries no unambiguous signal for them.
         */
        expectedPredicates: [
          'brand_voice',
          'brand_archetype',
          'tone_of_voice',
          'target_audience_segment',
          'content_guideline',
          'tension_point',
          'forbidden_pattern',
        ],
      } satisfies SetupMentionStep,
    ],
    queries: [],
  },
];
