import { getMessages } from '../../lib/i18n'

/**
 * The demo's banner and button copy, from the locale files. The wording is
 * the family's shared DEMO_COPY (@inite/auth/demo-ui) for ru and en, kept
 * here because this public repo takes no private package.
 */
export function demoCopy(lang: string | undefined) {
  return getMessages(lang).demo
}

/** "1 ч 42 мин", "12 мин", "1 мин" (never "0 мин" while time is left). */
export function formatDemoLeft(ms: number, lang: string | undefined): string {
  const c = demoCopy(lang)
  const total = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m} ${c.minutes}`
  return m ? `${h} ${c.hours} ${m} ${c.minutes}` : `${h} ${c.hours}`
}

/** The demo's end from `document.cookie`, or null outside a demo. */
export function readDemoEnd(cookie: string): Date | null {
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== 'demo_session') continue
    const n = Number(decodeURIComponent(rest.join('=')))
    return Number.isFinite(n) && n > 1_000_000_000 ? new Date(n * 1000) : null
  }
  return null
}

export function demoSignInHref(lang: string, persona = 'owner'): string {
  const params = new URLSearchParams({
    persona,
    lang,
    return_to: `/${lang}/app/demo`,
  })
  return `/api/auth/demo?${params.toString()}`
}
