/** One entity brain returned, with the facts the recall shows of it. */
export type BrainHit = { name: string; facts: string[] }

/** What brain recalled for the last prompt, or why it recalled nothing. */
export type BrainRecall = {
  query: string
  hits: BrainHit[]
  ms: number
  /** Set when the recall did not come back: `timeout`, `error`, `offline`. */
  failure?: string
}

/** The workspace this connection writes to, from `workspace_status`. */
export type BrainWorkspace = { name: string; facts: number; entities: number }

declare module 'claude-code' {
  interface PluginState {
    'inite-brain': {
      recall: BrainRecall | null
      found: BrainRecall | null
      workspace: BrainWorkspace | null
      isBandHidden: boolean
    }
  }
}
