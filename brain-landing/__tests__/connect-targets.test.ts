import { describe, it, expect } from 'vitest'
import { CONNECT_TARGETS, MCP_URL } from '../lib/connect-targets'
import en from '../locales/en/common.json'
import ru from '../locales/ru/common.json'

/**
 * Install links rot silently: a deeplink whose payload stopped parsing
 * still renders as a button, and the only symptom is a client that opens
 * and does nothing. These assertions decode the payloads rather than
 * matching the strings.
 */
describe('connect targets', () => {
  const byId = Object.fromEntries(CONNECT_TARGETS.map((t) => [t.id, t]))

  it('gives every target exactly one action', () => {
    // A card with neither is a dead end; a card with both asks the user
    // to choose between two things that do the same job.
    for (const target of CONNECT_TARGETS) {
      expect(Boolean(target.href) !== Boolean(target.copy)).toBe(true)
    }
  })

  it('claims a deeplink only for the two clients that publish one', () => {
    const deeplinks = CONNECT_TARGETS.filter((t) => t.kind === 'deeplink').map((t) => t.id)
    expect(deeplinks.sort()).toEqual(['cursor', 'vscode'])
    for (const target of CONNECT_TARGETS) {
      expect(Boolean(target.href)).toBe(target.kind === 'deeplink')
    }
  })

  it('encodes a Cursor payload Cursor can actually read', () => {
    const url = new URL(byId.cursor!.href!)
    expect(url.protocol).toBe('cursor:')
    const config = JSON.parse(atob(url.searchParams.get('config')!))
    expect(config.url).toBe(MCP_URL)
    expect(config.transport).toBe('http')
    expect(config.headers.Authorization).toMatch(/^Bearer brain_/)
  })

  it('encodes a VS Code payload VS Code can actually read', () => {
    const href = byId.vscode!.href!
    expect(href.startsWith('vscode:mcp/install?')).toBe(true)
    const config = JSON.parse(decodeURIComponent(href.slice('vscode:mcp/install?'.length)))
    expect(config).toMatchObject({ name: 'brain', type: 'http', url: MCP_URL })
  })

  it('sends ChatGPT to the profile its connector contract requires', () => {
    // The default surface exposes more than search + fetch and would be
    // refused; this is the one URL that must not be the plain one.
    expect(byId.chatgpt!.copy).toBe(`${MCP_URL}?tools=chatgpt`)
    expect(byId.claude!.copy).toBe(MCP_URL)
  })

  it('carries no real credential', () => {
    const serialised = JSON.stringify(CONNECT_TARGETS)
    expect(serialised).not.toMatch(/brain_[0-9a-f]{8}/)
  })

  it('has copy for every target in both locales', () => {
    // A missing note renders as `undefined` under a button.
    for (const target of CONNECT_TARGETS) {
      for (const locale of [en, ru]) {
        const notes = (locale as { connectBlock: { notes: Record<string, string> } }).connectBlock
          .notes
        expect(typeof notes[target.id]).toBe('string')
        expect(notes[target.id]!.length).toBeGreaterThan(0)
      }
    }
  })
})
