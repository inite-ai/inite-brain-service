/**
 * Tiny dict-based i18n. Two locales: `en` (default) and `ru`. Strings
 * live in `locales/<lang>/common.json` and are imported statically so
 * Next.js can server-render every variant. No runtime fetch, no
 * client provider — `getMessages(lang)` is a sync function.
 *
 * Mismatch with @inite/i18n: this landing is a single-app sibling and
 * doesn't pull in the shared LangContext + provider stack. If we
 * later need shared locale infra (forms, dates), swap to @inite/i18n.
 */

import en from '../locales/en/common.json'
import ru from '../locales/ru/common.json'

export type Lang = 'en' | 'ru'
export const LANGS: Lang[] = ['en', 'ru']
export const DEFAULT_LANG: Lang = 'en'

type Messages = typeof en

const DICT: Record<Lang, Messages> = { en, ru: ru as Messages }

export function getMessages(lang: string | undefined): Messages {
  if (lang === 'ru') return DICT.ru
  return DICT.en
}

export function normalizeLang(lang: string | undefined): Lang {
  return lang === 'ru' ? 'ru' : 'en'
}
