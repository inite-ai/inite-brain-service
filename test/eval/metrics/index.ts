export { recallAtK, recallAtKVector } from './recall-at-k';
export { meanReciprocalRank, reciprocalRankVector } from './mrr';
export { bootstrapMeanCI } from './bootstrap';
export type { BootstrapCI, BootstrapOptions } from './bootstrap';
export { extractionRecall, entityExtractionRate } from './extraction-recall';
export { identityResolutionRate, identityResolutionMetrics } from './identity-resolution';
export type { IdentityResolutionMetrics } from './identity-resolution';
export { piiGatingCorrectness } from './pii-gating';
export { memoryLifecycleCorrectness } from './memory-lifecycle';
export { ndcgAtK, ndcgAtKVector } from './ndcg';
export { miaAuc } from './mia-auc';
export { jointF1, meanJointF1 } from './joint-f1';
export type { JointF1Predicted, JointF1Expected, JointF1Score, JointF1Aggregate } from './joint-f1';
export { computeFaithfulness, meanFaithfulness } from './faithfulness';
export { refusalRate, confabulationCount } from './hallucination-resistance';
export type {
  FaithfulnessInput,
  FaithfulnessScore,
  FaithfulnessClaim,
  FaithfulnessSourceFact,
  OpenAiLike,
} from './faithfulness';

// ── Multilingual matrix (Tier 0) pure scorers ─────────────────────────
export { extractionF1, meanExtractionF1 } from './multilingual-extraction-f1';
export type { PrecisionRecallF1, ExtractionF1Aggregate } from './multilingual-extraction-f1';
export { entityLinkingAccuracy, fragmentationRate } from './entity-linking';
export type { FragmentationResult } from './entity-linking';
export {
  recallAtKRanked,
  ndcgAtKRanked,
  aggregateRecallAtK,
  aggregateNdcgAtK,
} from './cross-lingual-retrieval';
export type {
  RetrievalDirection,
  RetrievalQuery,
  RetrievalAggregate,
} from './cross-lingual-retrieval';
export { temporalExactDayAccuracy, temporalAccuracyByLocale } from './temporal-accuracy';
export type { TemporalRecord } from './temporal-accuracy';
export { labelClassificationMetrics } from './label-f1';
export type { LabelRecord, LabelClassMetrics, LabelClassificationResult } from './label-f1';
export { answerLanguageCorrectness, answerLanguageMismatches } from './answer-language';
export type { AnswerLangRecord } from './answer-language';
export { expectedCalibrationError, abstentionSplit } from './abstention-calibration';
export type {
  CalibrationRecord,
  AbstentionRecord,
  AbstentionSplit,
} from './abstention-calibration';
export { aggregateLanguageAttribution } from './language-attribution';
