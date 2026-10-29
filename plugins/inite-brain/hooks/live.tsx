import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { BrainHit, BrainRecall, BrainWorkspace } from '../types'

/**
 * Brain inside the session, not only at its edges.
 *
 * The command hooks beside this module recall once, when a session
 * starts, and capture when it compacts or ends. Between those two moments
 * the model only reaches memory if it decides to call a brain tool. This
 * module closes that gap where the engine allows it:
 *
 * - every prompt is looked up in brain before the model reads it, and
 *   what comes back rides beside the prompt as context the person never
 *   has to paste (bounded: a slow brain costs at most RECALL_TIMEOUT_MS,
 *   and a failure costs nothing but the recall);
 * - a band above the prompt says what was recalled, so memory working is
 *   visible rather than assumed;
 * - `/brain` opens a pane to ask memory directly, without a model turn;
 * - the status line names the workspace this session writes to.
 *
 * Every call goes through the plugin's own MCP connection (`$.mcp`), so
 * whatever credential that connection holds — the API key from the
 * plugin's settings, or an OAuth sign-in — is the one used. This module
 * never sees a key.
 */

const PANE = 'brain'
const RECALL_TIMEOUT_MS = 2500
const MIN_PROMPT_CHARS = 15
const MAX_CONTEXT_CHARS = 2000
const HITS = 6

const recallAtom = atom({ plugin: 'inite-brain', key: 'recall' } as const, null)
const foundAtom = atom({ plugin: 'inite-brain', key: 'found' } as const, null)
const workspaceAtom = atom({ plugin: 'inite-brain', key: 'workspace' } as const, null)
const hiddenAtom = atom({ plugin: 'inite-brain', key: 'isBandHidden' } as const, false)

type Options = { user_id?: string; recall_each_prompt?: boolean }

/** The JSON a brain tool answered with, or null when it answered none. */
function payload(result: McpToolResult) {
  if (result.isError) return null
  const block = result.content.find(one => one.type === 'text')
  const text = block && 'text' in block ? block.text : undefined
  if (typeof text !== 'string' || !text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export function hitsOf(out: Record<string, unknown> | null): BrainHit[] {
  const results = Array.isArray(out?.results) ? out.results : []
  const hits: BrainHit[] = []
  for (const raw of results as Array<Record<string, unknown>>) {
    const facts = (Array.isArray(raw.facts) ? raw.facts : [])
      .slice(0, 4)
      .map((f: Record<string, unknown>) => `${String(f.predicate ?? '')} ${String(f.object ?? '')}`.trim())
      .filter(Boolean)
    if (typeof raw.canonicalName === 'string' && facts.length > 0) {
      hits.push({ name: raw.canonicalName, facts })
    }
  }
  return hits.slice(0, HITS)
}

/** The recall as the model reads it: one line per entity, bounded. */
export function contextOf(hits: BrainHit[]): string {
  const lines = [
    'Brain (long-term memory) recalled this for the prompt above. It may be stale or beside the point — use what bears on the request, and ask brain directly (its MCP tools) for more or to check:',
  ]
  for (const hit of hits) {
    const line = `- ${hit.name}: ${hit.facts.join('; ')}`
    if (lines.join('\n').length + line.length > MAX_CONTEXT_CHARS) break
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * One search_knowledge call, bounded by `RECALL_TIMEOUT_MS`: a recall that
 * is late is dropped rather than waited for, because the person is
 * waiting on the prompt behind it.
 */
async function search(
  $: EngineInterface,
  at: { server: string | null; userId?: string | undefined },
  query: string,
  signal?: AbortSignal,
): Promise<BrainRecall> {
  const started = await $.clock.now()
  if (at.server === null) return { query, hits: [], ms: 0, failure: 'offline' }
  const args: Record<string, unknown> = { query, limit: HITS }
  if (at.userId) args.userId = at.userId
  const call = $.mcp.call(at.server, 'search_knowledge', args).then(
    (result: McpToolResult) => ({
      hits: hitsOf(payload(result)),
      failure: result.isError ? 'error' : undefined,
    }),
    () => ({ hits: [] as BrainHit[], failure: 'error' }),
  )
  const timeout = $.clock
    .sleep(RECALL_TIMEOUT_MS, signal ? { signal } : undefined)
    .then(() => ({ hits: [] as BrainHit[], failure: 'timeout' }))
    .catch(() => ({ hits: [] as BrainHit[], failure: 'timeout' }))
  const { hits, failure } = await Promise.race([call, timeout])
  const ms = (await $.clock.now()) - started
  return failure ? { query, hits, ms, failure } : { query, hits, ms }
}

export const register: Register = (on, options) => {
  const opts = options as Options
  // The name /mcp lists the plugin's server under; set at session start.
  let server: string | null = null
  const at = () => ({ server, userId: opts.user_id })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'brain',
      description: 'Ask brain (long-term memory) directly: /brain [question]',
      argumentHint: '[question]',
    })
    const connected = await $.mcp.connect('brain')
    if (!connected.isConnected) {
      $.ui.status('brain · not connected (/mcp)')
      return next(e)
    }
    server = connected.server
    const status = payload(await $.mcp.call(server, 'workspace_status', {}).catch(() => ({ content: [], isError: true })))
    const memory = (status?.memory ?? {}) as Record<string, unknown>
    const workspace: BrainWorkspace = {
      name: String(status?.displayName ?? status?.companyId ?? 'workspace'),
      facts: Number(memory.facts ?? 0),
      entities: Number(memory.entities ?? 0),
    }
    await update($, workspaceAtom, () => workspace)
    $.ui.status(status ? `brain · ${workspace.name} · ${workspace.facts} facts` : 'brain · connected')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (opts.recall_each_prompt === false || e.command || e.isMeta) return next(e)
    if (e.text.trim().length < MIN_PROMPT_CHARS) return next(e)
    const recall = await search($, at(), e.text, next.signal)
    await update($, recallAtom, () => recall)
    if (recall.hits.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), contextOf(recall.hits)] })
  })
    // Memory is an extra, never a gate: a recall that throws or overruns
    // lets the prompt through as typed (replayed if it already went on).
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'brain' }, async ($, e) => {
    const question = e.args.trim()
    if (question) await update($, foundAtom, () => null)
    await $.ui.open({ id: PANE, title: 'Brain' })
    if (question) {
      const found = await search($, at(), question)
      await update($, foundAtom, () => found)
      return { text: `Brain found ${found.hits.length} for "${question}".` }
    }
    return { text: 'Brain pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const recall = await read($, recallAtom)
    if (e.props.hasSurvey || recall === null || recall.hits.length === 0 || (await read($, hiddenAtom))) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const names = recall.hits.map(hit => hit.name).join(', ')
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          brain recalled {recall.hits.length}: {names}{' '}
        </Text>
        <Button key="open" plain label="[open]" onPress={() => void $.ui.open({ id: PANE, title: 'Brain' })} />
        <Text> </Text>
        <Button key="hide" plain label="[hide]" onPress={() => update($, hiddenAtom, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    // Mobile draws no text field: the pane there shows the last recall only.
    const Input = 'Input' in elements ? elements.Input : undefined
    const workspace = await read($, workspaceAtom)
    const found = (await read($, foundAtom)) ?? (await read($, recallAtom))
    const heading = workspace
      ? `${workspace.name} · ${workspace.entities} entities · ${workspace.facts} facts`
      : server === null
        ? 'Not connected — run /mcp to sign in to brain.'
        : 'Connected.'
    const ask = (value: string) => {
      const query = value.trim()
      if (!query) return
      void update($, foundAtom, () => ({ query, hits: [], ms: 0 })).then(async () => {
        const result = await search($, at(), query)
        await update($, foundAtom, () => result)
      })
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{heading}</Text>
        {Input && <Input key="ask" label="Ask brain" placeholder="what do we know about…" onSubmit={ask} />}
        {found === null && <Text dimColor>Nothing asked yet.</Text>}
        {found !== null && (
          <Text bold>
            {found.query.length > 60 ? `${found.query.slice(0, 60)}…` : found.query}
            {found.failure ? ` — ${found.failure}` : ` — ${found.hits.length} in ${Math.round(found.ms)} ms`}
          </Text>
        )}
        {found?.hits.map(hit => (
          <Box flexDirection="column" key={hit.name}>
            <Text>{hit.name}</Text>
            {hit.facts.map(fact => (
              <Text dimColor>  {fact}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
