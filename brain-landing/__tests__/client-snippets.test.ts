/**
 * The snippets on the Keys screen are the product's answer to "how do I
 * connect this?", so the thing worth testing is that they are complete:
 * the tenant, the endpoint and the key are all baked in, and none of the
 * placeholder text that made the old screen unusable survives.
 */
import { describe, it, expect } from 'vitest'
import { clientSnippets } from '@/lib/client-snippets'

const INPUT = {
  key: 'brain_' + 'a'.repeat(48),
  companyId: 'co_acme',
  mcpUrl: 'https://brain.inite.ai/mcp/co_acme',
}

describe('clientSnippets', () => {
  const snippets = clientSnippets(INPUT)

  it('covers the harnesses whose config shape we have verified', () => {
    expect(snippets.map((s) => s.id)).toEqual([
      'claude-code',
      'claude-desktop',
      'cursor',
      'vscode',
      'codex',
      'goose',
      'rest',
    ])
  })

  it('bakes the real key into every snippet, with no placeholders left', () => {
    for (const snippet of snippets) {
      expect(snippet.code).toContain(INPUT.key)
      expect(snippet.code).not.toMatch(/YOUR_API_KEY|YOUR_COMPANY_ID|<companyId>|<api-key>/)
    }
  })

  it('points every remote client at this tenant\'s endpoint', () => {
    for (const id of ['claude-code', 'cursor', 'vscode', 'codex', 'goose']) {
      expect(snippets.find((s) => s.id === id)!.code).toContain(INPUT.mcpUrl)
    }
  })

  it('gives the stdio connector the company id it needs instead of a URL', () => {
    const desktop = JSON.parse(snippets.find((s) => s.id === 'claude-desktop')!.code)
    expect(desktop.mcpServers.brain.env.BRAIN_COMPANY_ID).toBe('co_acme')
    expect(desktop.mcpServers.brain.args).toContain('@inite/brain-mcp')
    // Hosted default needs no base URL override.
    expect(desktop.mcpServers.brain.env.BRAIN_BASE_URL).toBeUndefined()
  })

  it('teaches a self-hosted deployment where its own brain lives', () => {
    const selfHosted = clientSnippets({
      ...INPUT,
      mcpUrl: 'http://localhost:3000/mcp/co_demo',
      companyId: 'co_demo',
    })
    const desktop = JSON.parse(selfHosted.find((s) => s.id === 'claude-desktop')!.code)
    expect(desktop.mcpServers.brain.env.BRAIN_BASE_URL).toBe('http://localhost:3000')
    expect(selfHosted.find((s) => s.id === 'rest')!.code).toContain('http://localhost:3000/v1/search')
  })

  it('emits valid JSON where the target file is JSON', () => {
    for (const id of ['claude-desktop', 'cursor', 'vscode']) {
      const snippet = snippets.find((s) => s.id === id)!
      expect(() => JSON.parse(snippet.code)).not.toThrow()
      expect(snippet.target).toMatch(/\.json$/)
    }
  })
})
