import { describe, it, expect } from 'vitest'
import { MCP_CONFIG, QUICKSTART_EXAMPLES } from '../lib/quickstart'

const example = (id: string) => QUICKSTART_EXAMPLES.find((item) => item.id === id)!
const curlBodies = (code: string) =>
  [...code.matchAll(/-d '(.*?)'/gs)].map((match) => JSON.parse(match[1]))

/** Run a TypeScript example against a fake fetch and report the calls. */
async function runExample(
  id: string,
  fetch: (url: string, init: RequestInit) => Promise<unknown>,
  env: Record<string, string>,
) {
  const run = new Function('fetch', 'process', `return (async () => { ${example(id).code} })()`)
  await run(fetch, { env })
}

describe('copyable quickstart examples', () => {
  it('configures the first-party stdio bridge with the required environment', () => {
    const server = JSON.parse(MCP_CONFIG).mcpServers.brain
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', '@inite/brain-mcp'])
    expect(Object.keys(server.env).sort()).toEqual(['BRAIN_API_KEY', 'BRAIN_COMPANY_ID'])
  })

  it('leads with the smallest write that works — text and a user, nothing else', () => {
    // The first thing a reader copies decides whether they get to a
    // result. Five domain concepts before the first success is the
    // category's worst onboarding, and we had it.
    const [write] = curlBodies(example('curl').code)
    expect(Object.keys(write).sort()).toEqual(['text', 'userId'])
    expect(example('curl').code).toContain('/v1/ingest/mention')
  })

  it('writes and searches the same personal scope', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      expect(init.headers).toMatchObject({ Authorization: 'Bearer brain_example' })
      return { ok: true, json: async () => ({ hits: [] }) }
    }
    await runExample('sdk', fetch, { BRAIN_KEY: 'brain_example' })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/v1/ingest/mention')
    expect(calls[1].url).toContain('/v1/search')
    expect(calls[1].body.userId).toBe(calls[0].body.userId)
    // The REST tab and the TypeScript tab must stay the same two calls.
    expect(curlBodies(example('curl').code)).toEqual(calls.map((call) => call.body))
  })

  it('keeps the typed path complete, as the precision route', () => {
    const [write, read] = curlBodies(example('typed').code)
    for (const field of ['entityRef', 'predicate', 'object', 'validFrom', 'source']) {
      expect(write).toHaveProperty(field)
    }
    expect(Number.isNaN(Date.parse(String(write.validFrom)))).toBe(false)
    expect(read.userId).toBe(write.userId)
  })

  it('stops when the write fails instead of implying the memory was stored', async () => {
    let requests = 0
    const fetch = async () => {
      requests++
      return { ok: false, status: 401 }
    }
    await expect(runExample('sdk', fetch, {})).rejects.toThrow('Ingest failed: 401')
    expect(requests).toBe(1)
  })
})
