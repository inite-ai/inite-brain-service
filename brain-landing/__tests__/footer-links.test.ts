/**
 * Every internal link in the footer must point at a page that exists.
 *
 * The footer renders on every page of the site, so a wrong href there is not
 * one broken link — it is one broken link times the whole corpus, and nothing
 * fails when it happens. `/[lang]/docs/search` shipped that way: the page has
 * always been `/[lang]/docs/api/search`, and the only thing that ever noticed
 * was Google's 2026-08 crawl, filing it under not-found weeks later.
 *
 * Scope is internal links, checked against the same DOCS_PAGES registry the
 * router and the sitemap read. The absolute ones (github.com, /openapi.json,
 * /health) are not reachable from a unit test; /openapi.json is covered
 * instead by the deploy's external probe and by the drift gate in
 * test/openapi-doc.unit-spec.ts.
 */
import { describe, it, expect } from 'vitest'
import { footerColumns } from '@/components/Footer'
import { LANGS } from '@/lib/i18n'
import { DOCS_PAGES } from '@/lib/docs-nav'

/** Locale-prefixed routes that exist without being a doc page. */
const STATIC_ROUTES = new Set(['', '/docs', '/blog'])

function internalHrefs(lang: (typeof LANGS)[number]): string[] {
  return footerColumns(lang)
    .flatMap((c) => c.links)
    .filter((l) => !('ext' in l && l.ext))
    .map((l) => l.href)
    .filter((h) => h.startsWith('/'))
}

describe('footer links', () => {
  const docSlugs = new Set(DOCS_PAGES.map((p) => p.slug))

  it.each(LANGS)('resolves every internal link for %s', (lang) => {
    const dead = internalHrefs(lang).filter((href) => {
      const rest = href.replace(new RegExp(`^/${lang}`), '')
      if (STATIC_ROUTES.has(rest)) return false
      const slug = rest.replace(/^\/docs\//, '')
      return rest.startsWith('/docs/') ? !docSlugs.has(slug) : true
    })
    expect(dead, `footer links with no page behind them: ${dead.join(', ')}`).toEqual([])
  })

  it('prefixes every internal link with its locale', () => {
    for (const lang of LANGS) {
      for (const href of internalHrefs(lang)) {
        expect(href.startsWith(`/${lang}`), `${href} is not under /${lang}`).toBe(true)
      }
    }
  })
})
