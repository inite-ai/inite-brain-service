import type {
  SourceAvailability,
  SourceCatalogEntry,
  SourceConnection,
} from '../../../lib/contracts/admin-source-connections'

/**
 * What an operator connects is a KIND of thing — a folder, a site, a
 * bucket, an MCP server, a repository — not a pack's `sources[]` entry.
 * A pack declares one entry per shape (text documents vs. files) of the
 * same thing; the catalogue shows one card per (pack, kind) and the
 * flow asks "what's in it" instead of listing the entries twice.
 */
export type SourceFamily = 'folder' | 'bucket' | 'site' | 'mcp' | 'repo' | 'external' | 'other'

export function familyOf(e: { kind: string; connector: string }): SourceFamily {
  if (e.kind === 'external') return 'external'
  if (e.kind === 'mcp') return 'mcp'
  switch (e.connector) {
    case 'fs':
      return 'folder'
    case 's3':
      return 'bucket'
    case 'url':
      return 'site'
    case 'git':
      return 'repo'
    default:
      return 'other'
  }
}

export interface SourceCard {
  key: string
  family: SourceFamily
  packId: string
  packVersion: string
  builtin: boolean
  accepted: boolean
  /** The entries of this kind the pack declares, document shape first. */
  entries: SourceCatalogEntry[]
  /** The best availability across the entries (ready > agent > external > disabled > missing). */
  availability: SourceAvailability
  connector: string
  /** Set when another pack offers the same kind — the card then names its pack. */
  ambiguous: boolean
}

const SHAPE_ORDER: Record<string, number> = { document: 0, binary: 1, conversation: 2, structure: 3 }
const AVAILABILITY_RANK: Record<SourceAvailability, number> = {
  ready: 0,
  agent: 1,
  external: 2,
  disabled: 3,
  missing: 4,
}

/** The kind of thing an entry reads, pack-independent: family + connector, and the transport for MCP. */
function kindKeyOf(e: SourceCatalogEntry): string {
  const family = familyOf(e)
  return `${family}/${family === 'mcp' ? (e.mcp?.transport ?? 'http') : e.connector}`
}

/** One card per (pack, kind), ready ones first, then agent, external, switched-off, missing. */
export function cardsOf(sources: SourceCatalogEntry[]): SourceCard[] {
  const byKey = new Map<string, SourceCard>()
  for (const e of sources) {
    const family = familyOf(e)
    const key = `${e.packId}/${kindKeyOf(e)}`
    const card = byKey.get(key) ?? {
      key,
      family,
      packId: e.packId,
      packVersion: e.packVersion,
      builtin: e.builtin,
      accepted: e.accepted,
      entries: [],
      availability: e.availability,
      connector: e.connector,
      ambiguous: false,
    }
    card.entries.push(e)
    if (AVAILABILITY_RANK[e.availability] < AVAILABILITY_RANK[card.availability]) {
      card.availability = e.availability
    }
    byKey.set(key, card)
  }
  const cards = [...byKey.values()]
  const kindsSeen = new Map<string, number>()
  for (const c of cards) {
    const k = kindKeyOf(c.entries[0]!)
    kindsSeen.set(k, (kindsSeen.get(k) ?? 0) + 1)
  }
  for (const c of cards) {
    c.entries.sort((a, b) => (SHAPE_ORDER[a.shape] ?? 9) - (SHAPE_ORDER[b.shape] ?? 9))
    c.ambiguous = (kindsSeen.get(kindKeyOf(c.entries[0]!)) ?? 0) > 1
  }
  return cards.sort(
    (a, b) =>
      AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability] ||
      a.family.localeCompare(b.family) ||
      a.packId.localeCompare(b.packId),
  )
}

/** The choice the flow offers when a kind comes in more than one shape. */
export type ShapeChoice = 'document' | 'binary' | 'both'

export function shapeChoices(card: SourceCard): ShapeChoice[] {
  const shapes = new Set(card.entries.map((e) => e.shape))
  if (shapes.has('document') && shapes.has('binary')) return ['document', 'binary', 'both']
  return []
}

/** The entries a choice creates connections for (no choice = the card's first, document-shaped, entry). */
export function entriesFor(card: SourceCard, choice: ShapeChoice | null): SourceCatalogEntry[] {
  if (choice === 'both') {
    return card.entries.filter((e) => e.shape === 'document' || e.shape === 'binary')
  }
  if (choice === 'document' || choice === 'binary') {
    return card.entries.filter((e) => e.shape === choice).slice(0, 1)
  }
  return card.entries.slice(0, 1)
}

/** The kind + shape line a connection reads as (`Folder · files`). */
export function connectionFamily(c: SourceConnection): SourceFamily {
  return familyOf(c)
}
