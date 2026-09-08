import { describe, expect, it } from 'vitest'
import { GET } from '../app/.well-known/agent-card.json/route'
import { GET as manifest } from '../app/.well-known/agent-actions/route'

/**
 * A2A reached v1.0 under the Linux Foundation in 2026, and this path is what
 * another vendor's agent looks for. Brain published `agent-actions` — INITE's
 * own convention, read by nothing outside this company — and nothing at the
 * standard one, so an agent following the discovery chain found a 404.
 */

async function card(): Promise<Record<string, unknown>> {
  return JSON.parse(await GET().text()) as Record<string, unknown>
}

describe('the agent card', () => {
  it('carries every field v1.0 requires', async () => {
    const c = await card()
    for (const field of [
      'name', 'description', 'supportedInterfaces', 'version',
      'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills',
    ]) {
      expect(c[field], `missing ${field}`).toBeDefined()
    }
    expect(Array.isArray(c.supportedInterfaces)).toBe(true)
    expect((c.supportedInterfaces as unknown[]).length).toBeGreaterThan(0)
  })

  it('declares only the protocol it actually speaks', async () => {
    /**
     * Brain speaks REST and MCP. `HTTP+JSON` is an A2A core binding meaning
     * A2A over HTTP, not "this service has a REST API" — declaring it would
     * tell a client it can speak A2A here, which it cannot.
     */
    const interfaces = (await card()).supportedInterfaces as { protocolBinding: string; url: string }[]
    expect(interfaces.map((i) => i.protocolBinding)).toEqual(['MCP'])
    // Multi-tenant: a card naming one fixed URL would name one that works
    // for nobody.
    expect(interfaces[0].url).toContain('{companyId}')
  })

  it('lists the same operations the manifest does', async () => {
    // Derived from one array rather than retyped. Two lists of the same nine
    // operations disagree the first time one of them changes.
    const actions = (JSON.parse(await manifest().text()) as { actions: { id: string }[] }).actions
    const skills = (await card()).skills as { id: string }[]
    expect(skills.map((s) => s.id)).toEqual(actions.map((a) => a.id))
    expect(skills.length).toBeGreaterThan(5)
  })

  it('gives every skill the fields a client reads', async () => {
    for (const skill of (await card()).skills as Record<string, unknown>[]) {
      expect(typeof skill.name).toBe('string')
      expect(String(skill.description).length).toBeGreaterThan(20)
      expect(Array.isArray(skill.tags)).toBe(true)
      expect((skill.tags as string[]).length).toBeGreaterThan(0)
    }
  })

  it('names the writes as writes', async () => {
    const skills = (await card()).skills as { id: string; tags: string[] }[]
    const forget = skills.find((s) => s.id === 'forget-entity')!
    expect(forget.tags).toContain('write')
    expect(skills.find((s) => s.id === 'search')!.tags).toContain('retrieval')
  })
})
