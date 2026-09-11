/**
 * The three sections added for the page's argument — problem, shared
 * graph, plain statements — carry claims rather than decoration, and a
 * claim that quietly stops matching the product is worse than no claim.
 * These assertions pin the parts that rot on their own: the client list
 * in the picture, the order the argument is made in, and the anchor the
 * section's CTA jumps to.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '@/locales/en/common.json'
import ru from '@/locales/ru/common.json'
import { CONNECT_TARGETS } from '../lib/connect-targets'

const page = readFileSync(join(__dirname, '../app/[lang]/page.tsx'), 'utf8')

describe('landing narrative', () => {
  it('states the problem before any of the mechanism', () => {
    // Hero → Problem → SharedGraph → MemoryLayers. Explaining how memory
    // is built lands only once the reader agrees it is missing.
    const order = ['<Hero', '<Problem', '<SharedGraph', '<MemoryLayers', '<Architecture']
    const positions = order.map((tag) => page.indexOf(tag))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('closes with the plain statements, just before the source links', () => {
    expect(page.indexOf('<PlainlyTrue')).toBeGreaterThan(page.indexOf('<SkillsInstall'))
    expect(page.indexOf('<PlainlyTrue')).toBeLessThan(page.indexOf('<OpenSource'))
  })

  it('draws the picture from the clients we actually connect', () => {
    // The chips are derived, not typed out: a client added to or dropped
    // from CONNECT_TARGETS must not leave the picture promising it.
    const source = readFileSync(join(__dirname, '../components/SharedGraph.tsx'), 'utf8')
    expect(source).toMatch(/CONNECT_TARGETS\.map\(\(t\) => t\.label\)/)
    expect(CONNECT_TARGETS.length).toBeGreaterThanOrEqual(6)
  })

  it('sends the shared-graph CTA to a section that exists on the page', () => {
    const source = readFileSync(join(__dirname, '../components/SharedGraph.tsx'), 'utf8')
    const target = source.match(/href="#([a-z-]+)"/)?.[1]
    expect(target).toBe('connect')
    const connect = readFileSync(join(__dirname, '../components/ConnectTargets.tsx'), 'utf8')
    expect(connect).toContain(`id="${target}"`)
  })

  it('keeps every section heading a claim rather than a label', () => {
    // A heading ending in a colon, or that is only a noun phrase naming
    // the section, tells the reader nothing they did not already see in
    // the nav. Cheap proxy: no trailing colon, and a verb-bearing
    // sentence long enough to assert something.
    const headings = [
      en.problem.title,
      en.sharedGraph.title,
      en.plainly.title,
      en.memoryLayers.title,
      en.architecture.title,
      en.features.title,
      en.skillsBlock.title,
    ]
    for (const h of headings) {
      expect(h, `"${h}" reads as a label`).not.toMatch(/:/)
      expect(h.split(/\s+/).length, `"${h}" is too short to be a claim`).toBeGreaterThan(3)
    }
  })

  it('has the new sections in both locales with no empty strings', () => {
    for (const locale of [en, ru] as const) {
      const blocks = [locale.problem, locale.sharedGraph, locale.plainly]
      for (const block of blocks) {
        for (const value of JSON.stringify(block).matchAll(/"([^"]*)"/g)) {
          expect(value[1]!.trim().length).toBeGreaterThan(0)
        }
      }
    }
  })
})
