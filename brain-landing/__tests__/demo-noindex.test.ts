/** The demo workspace is noindex and out of the sitemap; crawlers are kept off /app. */
import { describe, it, expect } from 'vitest'
import robots from '@/app/robots'
import sitemap from '@/app/sitemap'
import { metadata } from '@/app/[lang]/app/demo/layout'

describe('demo pages are not for search', () => {
  it('the demo layout says noindex', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
  })

  it('no sitemap entry is under /app', () => {
    for (const e of sitemap()) expect(new URL(e.url).pathname).not.toMatch(/^\/(en|ru)\/app(\/|$)/)
  })

  it('robots disallows the app shell for every agent', () => {
    const rules = robots().rules
    const list = Array.isArray(rules) ? rules : [rules]
    const star = list.find((r) => r.userAgent === '*')
    expect(star?.disallow).toEqual(expect.arrayContaining(['/en/app/', '/ru/app/']))
  })
})
