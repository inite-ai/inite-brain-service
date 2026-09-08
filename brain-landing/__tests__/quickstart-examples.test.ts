import { describe, it, expect } from 'vitest'
import { MCP_CONFIG, QUICKSTART_EXAMPLES } from '../lib/quickstart'

describe('copyable quickstart examples', () => {
  it('configures the first-party stdio bridge with the required environment', () => {
    const server = JSON.parse(MCP_CONFIG).mcpServers.brain
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', '@inite/brain-mcp'])
    expect(Object.keys(server.env).sort()).toEqual(['BRAIN_API_KEY', 'BRAIN_COMPANY_ID'])
  })

  it('writes and searches the same personal scope with required fact fields', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      expect(init.headers).toMatchObject({ Authorization: 'Bearer brain_example' })
      return { ok: true, json: async () => ({ hits: [] }) }
    }
    const code = QUICKSTART_EXAMPLES.find((item) => item.id === 'sdk')!.code
    const run = new Function('fetch', 'process', `return (async () => { ${code} })()`)
    await run(fetch, { env: { BRAIN_KEY: 'brain_example' } })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/v1/ingest/fact')
    for (const field of ['entityRef', 'predicate', 'object', 'validFrom', 'source']) {
      expect(calls[0].body).toHaveProperty(field)
    }
    expect(Number.isNaN(Date.parse(String(calls[0].body.validFrom)))).toBe(false)
    expect(calls[1].body.userId).toBe(calls[0].body.userId)
    const curl = QUICKSTART_EXAMPLES.find((item) => item.id === 'curl')!.code
    const bodies = [...curl.matchAll(/-d '(.*?)'/gs)].map((match) => JSON.parse(match[1]))
    expect(bodies).toEqual(calls.map((call) => call.body))
  })

  it('stops when the write fails instead of implying the memory was stored', async () => {
    let requests = 0
    const fetch = async () => { requests++; return { ok: false, status: 401 } }
    const code = QUICKSTART_EXAMPLES.find((item) => item.id === 'sdk')!.code
    const run = new Function('fetch', 'process', `return (async () => { ${code} })()`)
    await expect(run(fetch, { env: {} })).rejects.toThrow('Ingest failed: 401')
    expect(requests).toBe(1)
  })
})
