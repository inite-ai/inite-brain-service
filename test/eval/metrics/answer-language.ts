/**
 * Answer-language correctness — did the synthesized answer come back in
 * the language the caller asked in?
 *
 * A memory that stores a Russian fact, is asked in Russian, and answers
 * in English has failed even if the content is right. This metric
 * compares the DETECTED answer language to the INTENDED language (both
 * ISO 639-1). The detection itself lives in the runner's script detector;
 * this scorer is pure over the (detected, intended) pairs.
 *
 * null on empty so a locale-agnostic slice renders "—" rather than a
 * misleading 1.0 / 0.0.
 */

export interface AnswerLangRecord {
  /** Detected answer language (ISO 639-1) or null when undetermined. */
  detected: string | null;
  /** The language the answer was expected to be in (ISO 639-1). */
  intended: string;
}

export function answerLanguageCorrectness(records: AnswerLangRecord[]): number | null {
  if (records.length === 0) return null;
  const correct = records.filter((r) => r.detected === r.intended).length;
  return correct / records.length;
}

/** Diagnostic count of mismatches (including undetermined detections). */
export function answerLanguageMismatches(records: AnswerLangRecord[]): number {
  return records.filter((r) => r.detected !== r.intended).length;
}
