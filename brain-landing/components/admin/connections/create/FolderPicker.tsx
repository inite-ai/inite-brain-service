'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, Laptop, Loader2, Server } from 'lucide-react'
import { Modal } from '../../policies/ui'
import type {
  BrowseResponse,
  SourceAgent,
} from '../../../../lib/contracts/admin-source-connections'
import { PROXY, errorMessage, fill, stamp, type ConnectionsT } from '../shared'

/**
 * Pick the folder — and, inside it, the subfolders that are the source
 * — from a tree instead of typing paths. On the brain the tree is the
 * host's disk inside the SOURCE_FS_ROOTS jail (one level per request);
 * on an agent it is what that agent reported on its last check-in (the
 * brain never sees the laptop itself). Ticked subfolders become the
 * connection's `include`; none ticked = the whole folder.
 */
export function FolderPicker({
  host,
  agentId,
  initialRoot,
  initialInclude,
  t,
  onClose,
  onPick,
}: {
  host: 'server' | 'agent'
  agentId: string
  initialRoot: string
  initialInclude: string[]
  t: ConnectionsT
  onClose: () => void
  onPick: (root: string, include: string[]) => void
}) {
  const p = t.picker
  const [root, setRoot] = useState(initialRoot)
  const [ticked, setTicked] = useState<Set<string>>(new Set(initialInclude))
  const [agent, setAgent] = useState<SourceAgent | null | 'missing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (host !== 'agent') return
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const res = await fetch(`${PROXY}/agents`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        const found = (json as { agents: SourceAgent[] }).agents.find((a) => a.agentId === agentId)
        if (!cancelled) setAgent(found ?? 'missing')
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [host, agentId])

  const toggle = useCallback((rel: string) => {
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }, [])

  const chooseRoot = useCallback((path: string) => {
    setRoot(path)
    setTicked(new Set())
  }, [])

  return (
    <Modal title={p.title} onClose={onClose} wide>
      <div className="space-y-3 text-xs">
        <p className="text-[11px] text-[var(--text-muted)]">{host === 'agent' ? fill(p.agentHint, { agentId }) : p.serverHint}</p>
        {error && <div className="font-mono text-[var(--danger)]">{error}</div>}
        {loading && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />}
        <div className="max-h-[50vh] overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2">
          {host === 'server' ? (
            <ServerTree root={root} ticked={ticked} onRoot={chooseRoot} onToggle={toggle} t={t} />
          ) : agent === 'missing' ? (
            <p className="italic text-[var(--text-muted)]">{fill(p.agentMissing, { agentId })}</p>
          ) : agent ? (
            <AgentTree agent={agent} root={root} ticked={ticked} onRoot={chooseRoot} onToggle={toggle} t={t} />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] text-[var(--text-faint)] truncate">
            {root ? `${root}${ticked.size > 0 ? ` · ${fill(p.tickedCount, { n: ticked.size })}` : ''}` : p.nothingYet}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            >
              {t.create.cancel}
            </button>
            <button
              type="button"
              disabled={!root}
              onClick={() => onPick(root, [...ticked].sort())}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {p.use}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** The brain host's disk, one level per request, inside the jail. */
function ServerTree({
  root,
  ticked,
  onRoot,
  onToggle,
  t,
}: {
  root: string
  ticked: Set<string>
  onRoot: (path: string) => void
  onToggle: (rel: string) => void
  t: ConnectionsT
}) {
  const p = t.picker
  const [at, setAt] = useState<string>(root)
  const [level, setLevel] = useState<BrowseResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const q = at ? `?path=${encodeURIComponent(at)}` : ''
        const res = await fetch(`${PROXY}/browse${q}`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        if (!cancelled) {
          setLevel(json as BrowseResponse)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [at])

  if (error) return <p className="font-mono text-[var(--danger)]">{error}</p>
  if (!level) return <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />
  const insideRoot = root && level.path.startsWith(root)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        <Server className="w-3 h-3 text-[var(--text-muted)]" />
        {level.parent !== null && (
          <button type="button" onClick={() => setAt(level.parent ?? '')} className="text-[var(--accent)]">
            {p.up}
          </button>
        )}
        <span className="font-mono text-[var(--text)] truncate">{level.path || p.jailRoots}</span>
        {level.path && root !== level.path && (
          <button type="button" onClick={() => onRoot(level.path)} className="ml-auto text-[var(--accent)]">
            {p.useThis}
          </button>
        )}
        {root === level.path && <span className="ml-auto text-[var(--success)]">{p.isRoot}</span>}
      </div>
      {level.folders.length === 0 && <p className="italic text-[var(--text-muted)]">{fill(p.noFolders, { files: level.files })}</p>}
      {level.folders.map((f) => {
        const rel = insideRoot && root ? f.path.slice(root.length + 1) : null
        return (
          <div key={f.path} className="flex items-center gap-2 py-0.5">
            {rel !== null && rel.length > 0 ? (
              <input type="checkbox" checked={ticked.has(rel)} onChange={() => onToggle(rel)} title={p.tickHint} />
            ) : (
              <span className="w-3" />
            )}
            <button type="button" onClick={() => setAt(f.path)} className="inline-flex items-center gap-1 text-[var(--text)] hover:text-[var(--accent)]">
              <Folder className="w-3 h-3 text-[var(--text-muted)]" /> {f.name} <ChevronRight className="w-3 h-3 text-[var(--text-faint)]" />
            </button>
          </div>
        )
      })}
      {level.truncated && <p className="text-[10px] text-[var(--warning)]">{p.truncated}</p>}
    </div>
  )
}

/** What the agent reported: its roots and the folders under them, as a tree. */
function AgentTree({
  agent,
  root,
  ticked,
  onRoot,
  onToggle,
  t,
}: {
  agent: SourceAgent
  root: string
  ticked: Set<string>
  onRoot: (path: string) => void
  onToggle: (rel: string) => void
  t: ConnectionsT
}) {
  const p = t.picker
  const [open, setOpen] = useState<Set<string>>(new Set())
  const flip = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const trees = useMemo(
    () => agent.roots.map((r) => ({ path: r.path, children: childrenOf(r.folders) })),
    [agent],
  )
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-[var(--text-faint)]">
        <Laptop className="inline w-3 h-3 mr-1" />
        {fill(p.reportedAt, { at: stamp(agent.lastSeenAt), hostname: agent.hostname ?? agent.agentId })}
      </p>
      {trees.map((r) => (
        <div key={r.path}>
          <div className="flex items-center gap-2 text-[11px]">
            <FolderOpen className="w-3 h-3 text-[var(--text-muted)]" />
            <span className="font-mono text-[var(--text)]">{r.path}</span>
            {root === r.path ? (
              <span className="ml-auto text-[var(--success)]">{p.isRoot}</span>
            ) : (
              <button type="button" onClick={() => onRoot(r.path)} className="ml-auto text-[var(--accent)]">
                {p.useThis}
              </button>
            )}
          </div>
          <Branch
            base={r.path}
            nodes={r.children}
            depth={1}
            root={root}
            ticked={ticked}
            open={open}
            onFlip={flip}
            onRoot={onRoot}
            onToggle={onToggle}
            t={t}
          />
        </div>
      ))}
    </div>
  )
}

interface Node {
  name: string
  rel: string
  children: Node[]
}

/** Relative dir paths (sorted) → a tree. */
export function childrenOf(folders: string[]): Node[] {
  const roots: Node[] = []
  const byRel = new Map<string, Node>()
  for (const rel of folders) {
    const i = rel.lastIndexOf('/')
    const node: Node = { name: i === -1 ? rel : rel.slice(i + 1), rel, children: [] }
    byRel.set(rel, node)
    const parent = i === -1 ? null : byRel.get(rel.slice(0, i))
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function Branch({
  base,
  nodes,
  depth,
  root,
  ticked,
  open,
  onFlip,
  onRoot,
  onToggle,
  t,
}: {
  base: string
  nodes: Node[]
  depth: number
  root: string
  ticked: Set<string>
  open: Set<string>
  onFlip: (k: string) => void
  onRoot: (path: string) => void
  onToggle: (rel: string) => void
  t: ConnectionsT
}) {
  const p = t.picker
  return (
    <div style={{ paddingLeft: `${depth * 14}px` }}>
      {nodes.map((n) => {
        const abs = `${base}/${n.rel}`
        // Tick boxes live under the chosen root only: what they tick is `include` relative to it.
        const rel = root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
        const k = abs
        return (
          <div key={k}>
            <div className="flex items-center gap-2 py-0.5">
              {rel !== null ? (
                <input type="checkbox" checked={ticked.has(rel)} onChange={() => onToggle(rel)} title={p.tickHint} />
              ) : (
                <span className="w-3" />
              )}
              <button type="button" onClick={() => onFlip(k)} className="inline-flex items-center gap-1 text-[var(--text)] hover:text-[var(--accent)]">
                <Folder className="w-3 h-3 text-[var(--text-muted)]" /> {n.name}
                {n.children.length > 0 && (
                  <ChevronRight className={`w-3 h-3 text-[var(--text-faint)] transition-transform ${open.has(k) ? 'rotate-90' : ''}`} />
                )}
              </button>
              {root !== abs && (
                <button type="button" onClick={() => onRoot(abs)} className="text-[10px] text-[var(--text-faint)] hover:text-[var(--accent)]">
                  {p.useThis}
                </button>
              )}
              {root === abs && <span className="text-[10px] text-[var(--success)]">{p.isRoot}</span>}
            </div>
            {open.has(k) && n.children.length > 0 && (
              <Branch
                base={base}
                nodes={n.children}
                depth={depth + 1}
                root={root}
                ticked={ticked}
                open={open}
                onFlip={onFlip}
                onRoot={onRoot}
                onToggle={onToggle}
                t={t}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
