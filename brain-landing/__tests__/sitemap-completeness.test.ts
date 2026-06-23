/**
 * Sitemap completeness — runs the real sitemap() from app/sitemap.ts and
 * asserts the corpus is fully covered: every docs page × locale, every blog
 * post × locale, plus the home / docs-index / blog-index per locale, each
 * with hreflang alternates and a locale-prefixed URL.
 *
 * Catches the silent drift where a new doc or post never makes it into the
 * sitemap (broken slug, registry desync) — the kind of gap Search Console
 * only surfaces weeks later.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sitemap from '@/app/sitemap'
import { LANGS } from '@/lib/i18n'
import { DOCS_PAGES } from '@/lib/docs-nav'
import { getBlogSlugs } from '@/lib/blog'

const SITE = 'https://brain.inite.ai'

describe('sitemap()', () => {
  const sm = sitemap()
  const urls = sm.map((e) => e.url)

  it('emits root + (home/docs-index/blog-index + docs + blog) × locale', () => {
    const docs = DOCS_PAGES.length
    const blog = getBlogSlugs().length
    const perLocale = 3 + docs + blog // home, docs index, blog index, docs, posts
    const expected = 1 + perLocale * LANGS.length // +1 for the bare root
    expect(sm.length).toBe(expected)
  })

  it('every docs page appears under every locale', () => {
    for (const lang of LANGS) {
      for (const page of DOCS_PAGES) {
        const u = `${SITE}/${lang}/docs/${page.slug}`
        expect(urls, `missing ${u}`).toContain(u)
      }
    }
  })

  it('every blog post appears under every locale', () => {
    for (const lang of LANGS) {
      for (const slug of getBlogSlugs()) {
        const u = `${SITE}/${lang}/blog/${slug}`
        expect(urls, `missing ${u}`).toContain(u)
      }
    }
  })

  it('every non-root entry is locale-prefixed', () => {
    for (const entry of sm) {
      if (entry.url === SITE) continue
      const seg = new URL(entry.url).pathname.split('/').filter(Boolean)[0]
      expect(LANGS).toContain(seg as (typeof LANGS)[number])
    }
  })

  it('localized entries carry all locale hreflang alternates', () => {
    for (const entry of sm) {
      if (entry.url === SITE) continue
      const langs = Object.keys(entry.alternates?.languages ?? {})
      for (const l of LANGS) expect(langs, `${entry.url} missing ${l}`).toContain(l)
    }
  })

  it('no sitemap entry points at a content file that no longer exists', () => {
    // guards against a deleted post/doc lingering in a stale registry
    const blogDir = path.join(process.cwd(), 'content', 'blog', 'en')
    const onDisk = new Set(
      fs.readdirSync(blogDir).filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, '')),
    )
    for (const slug of getBlogSlugs()) {
      expect(onDisk, `sitemap lists blog/${slug} but file is gone`).toContain(slug)
    }
  })
})
