import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'plugin:inite-brain:brain'
const OPTIONS = { api_key: 'brain_test' }

const SEARCH = {
  results: [
    {
      canonicalName: 'Ledger Sync',
      facts: [
        { predicate: 'owned by', object: 'Ana' },
        { predicate: 'deploys to', object: 'fly.io' },
      ],
    },
    { canonicalName: 'Nameless', facts: [] },
  ],
}

const STATUS = { companyId: 'co_x', displayName: 'Acme memory', memory: { entities: 12, facts: 340 } }

type Seen = {
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  context: readonly string[] | undefined
  clock: MockClock
}

/**
 * The engine beneath the plugin: brain's MCP server answering from memory
 * (after `delayMs` on the mocked clock), and a prompt bottom that records
 * the context that reached the model.
 */
function engine(on: On, opts: { delayMs?: number; connected?: boolean } = {}): Seen {
  const seen: Seen = { calls: [], context: undefined, clock: mock.clock(on) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  // The engine's own band and pane draw nothing here.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('mcp.connect', () => ({
    value:
      opts.connected === false
        ? { isConnected: false, reason: 'failed', message: 'no' }
        : { isConnected: true, server: SERVER },
  }))
  on('mcp.call', async ($, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    if (opts.delayMs) await $.clock.sleep(opts.delayMs)
    const body = e.tool === 'workspace_status' ? STATUS : SEARCH
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
  })
  on('prompt.submit', ($, e) => {
    seen.context = e.context
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: null, isInteractive: true })
const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

describe('recall on every prompt', () => {
  test('attaches what brain recalls beside the prompt', { options: OPTIONS }, async ($, on) => {
    const seen = engine(on)
    await start($)
    await submit($, 'who owns the ledger sync service?')

    const search = seen.calls.find(c => c.tool === 'search_knowledge')
    expect(search?.args).toEqual({ query: 'who owns the ledger sync service?', limit: 6 })
    expect(seen.context?.length).toBe(1)
    expect(seen.context?.[0]).toContain('- Ledger Sync: owned by Ana; deploys to fly.io')
    // An entity with no facts says nothing worth a line.
    expect(seen.context?.[0]).not.toContain('Nameless')
  })

  test('asks for the configured user only', { options: { ...OPTIONS, user_id: 'u_7' } }, async ($, on) => {
    const seen = engine(on)
    await start($)
    await submit($, 'what did I decide about pricing?')
    expect(seen.calls.find(c => c.tool === 'search_knowledge')?.args.userId).toBe('u_7')
  })

  test('a slow brain is dropped, not waited for', { options: OPTIONS }, async ($, on) => {
    const seen = engine(on, { delayMs: 10_000 })
    await start($)
    const submitted = submit($, 'what do we know about the ledger?')
    await seen.clock.advance(2500)
    await submitted
    expect(seen.context).toBeUndefined()
  })

  test('leaves short prompts and slash commands alone', { options: OPTIONS }, async ($, on) => {
    const seen = engine(on)
    await start($)
    await submit($, 'yes')
    expect(seen.calls.filter(c => c.tool === 'search_knowledge')).toEqual([])
    expect(seen.context).toBeUndefined()
  })

  test('is off when the setting says so', { options: { ...OPTIONS, recall_each_prompt: false } }, async ($, on) => {
    const seen = engine(on)
    await start($)
    await submit($, 'who owns the ledger sync service?')
    expect(seen.calls.filter(c => c.tool === 'search_knowledge')).toEqual([])
  })

  test('without a connection, prompts pass untouched', { options: OPTIONS }, async ($, on) => {
    const seen = engine(on, { connected: false })
    await start($)
    await submit($, 'who owns the ledger sync service?')
    expect(seen.calls).toEqual([])
    expect(seen.context).toBeUndefined()
  })
})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
}

describe('the band above the prompt', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`says what was recalled, and hides on request (${surface})`, { options: OPTIONS }, async ($, on) => {
      engine(on)
      await start($)
      await submit($, 'who owns the ledger sync service?')

      const band = await $.ui.mount({ plugin: 'inite-brain', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ text: /brain recalled 1: Ledger Sync/ })).toBeDefined()

      await band.press({ key: 'hide' })
      expect(await band.find({ text: /brain recalled/ })).toBeUndefined()
    })
  }

  test('stays empty until something was recalled', { options: OPTIONS }, async ($, on) => {
    engine(on)
    await start($)
    const band = await $.ui.mount({ plugin: 'inite-brain', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /brain recalled/ })).toBeUndefined()
  })
})
