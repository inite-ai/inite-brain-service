import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARENT, COMPANY_ID, familySchema, articleSchema } from '@/lib/seo'
import { LANGS, getMessages } from '@/lib/i18n'

/**
 * Brain must link to the company that makes it, with an anchor a crawler
 * follows, and its JSON-LD must name that company as the one Organization.
 *
 * Owner, 13.11.2026: there is one company, inite LLC
 * (https://inite.ai/#organization), and Brain is its product. The graph
 * declares no Organization of Brain's own, no `parentOrganization` and no
 * `sameAs` to family sites. JSON-LD asserts a relationship; it does not
 * carry one. Meanwhile every MCP catalogue that
 * lists this server points at brain.inite.ai, so the only earned links the
 * family has were arriving here and stopping: inite.ai's own external profile
 * came to two donors, both of them listings of *this* server.
 *
 * The footer anchor is the edge that fixes it, and this is the gate that keeps
 * it from being refactored away.
 *
 * Scope note: the suite runs on `environment: 'node'` with no DOM, so the
 * component itself cannot be rendered here. The first two cases are real unit
 * assertions on the schema builder; the third reads the component source, and
 * is written that way on purpose rather than pretending to be a render.
 *
 * Proof it bites: delete the `<a href={PARENT.url}>` block from Footer.tsx.
 */

const FOOTER = readFileSync(join(__dirname, '..', 'components', 'Footer.tsx'), 'utf-8')

describe('the parent link', () => {
  it('is the company the graph names, and the graph declares no Organization of its own', () => {
    const graph = (familySchema('en') as Record<string, any>)['@graph'] as Record<string, any>[]
    expect(COMPANY_ID).toBe(`${PARENT.url}/#organization`)
    const orgs = graph.filter((n) => n['@type'] === 'Organization')
    expect(orgs).toEqual([{ '@type': 'Organization', '@id': COMPANY_ID, name: 'INITE', url: PARENT.url }])
    expect(graph.map((n) => n['@type'])).toEqual(['WebSite', 'SoftwareApplication', 'Brand', 'Organization'])
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication')!
    expect(app['@id']).toBe('https://brain.inite.ai/#app')
    expect(app.provider).toEqual({ '@id': COMPANY_ID })
    expect(app.publisher).toEqual({ '@id': COMPANY_ID })
    expect(app.brand).toEqual({ '@id': 'https://brain.inite.ai/#brand' })
    expect(graph[0].publisher).toEqual({ '@id': COMPANY_ID })
    const text = JSON.stringify(familySchema('ru'))
    expect(text).not.toContain('parentOrganization')
    expect(text).not.toContain('subOrganization')
    expect(text).not.toContain('brain.inite.ai/#organization')
    expect(text).not.toContain('sameAs')
  })

  it('names the company as author and publisher of a post', () => {
    const post = articleSchema({
      title: 't', description: 'd', url: 'https://brain.inite.ai/en/blog/x', datePublished: '2026-11-13',
      author: 'INITE Brain Team', section: 's', keywords: [], lang: 'en',
    }) as Record<string, any>
    expect(post.author['@id']).toBe(COMPANY_ID)
    expect(post.publisher['@id']).toBe(COMPANY_ID)
    expect(JSON.stringify(post)).not.toContain('parentOrganization')
  })

  it('points somewhere outside this site', () => {
    expect(PARENT.url).toMatch(/^https:\/\//)
    expect(PARENT.url).not.toContain('brain.')
  })

  it('is rendered by the footer, out of that one constant', () => {
    expect(FOOTER).toContain("from '../lib/seo'")
    expect(FOOTER).toMatch(/href=\{PARENT\.url\}/)
    // Not a hardcoded second copy of the address.
    expect(FOOTER).not.toContain('https://inite.ai')
  })

  it('has copy in every locale', () => {
    for (const lang of LANGS) {
      const maker = getMessages(lang).footer.maker
      expect(String(maker ?? '').trim().length, `${lang} footer.maker`).toBeGreaterThan(0)
    }
  })
})
