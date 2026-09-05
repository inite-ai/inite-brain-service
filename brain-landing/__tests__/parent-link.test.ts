import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARENT, organizationSchema } from '@/lib/seo'
import { LANGS, getMessages } from '@/lib/i18n'

/**
 * Brain must link to the company that makes it, with an anchor a crawler
 * follows.
 *
 * The relationship was already declared twice — `parentOrganization` and
 * `sameAs` in the JSON-LD — and linked zero times. JSON-LD asserts a
 * relationship; it does not carry one. Meanwhile every MCP catalogue that
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
  it('is the same address the schema claims as parent', () => {
    const org = organizationSchema() as Record<string, any>
    expect(org.parentOrganization.url).toBe(PARENT.url)
    expect(org.parentOrganization['@id']).toBe(`${PARENT.url}/#organization`)
    expect(org.sameAs).toContain(PARENT.url)
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
