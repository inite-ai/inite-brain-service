import { detectLanguage, LANG_HIGH_CONFIDENCE } from '../../ai/locale/language-detector';

/**
 * The language a query's terms are stemmed in for the stemmed lexical
 * field (0184, #892): the caller's explicit language, else the detector's
 * when it is confident — the same floor every language-aware read trusts.
 * Below it there is no stemming: a short Latin query the detector cannot
 * place would otherwise be stemmed as English against Portuguese rows.
 */
export function stemLangOf(query: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const detected = detectLanguage(query);
  return detected.language !== 'und' && detected.confidence >= LANG_HIGH_CONFIDENCE
    ? detected.language
    : undefined;
}
