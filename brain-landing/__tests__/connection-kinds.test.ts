import { describe, expect, it } from 'vitest'
import { cardsOf, entriesFor, familyOf, shapeChoices } from '@/components/admin/connections/kinds'
import type { SourceCatalogEntry } from '@/lib/contracts/admin-source-connections'

/**
 * The catalogue an operator sees is one card per KIND of thing a pack
 * can read — the pack's per-shape entries fold into "what's in it".
 */

function e(over: Partial<SourceCatalogEntry>): SourceCatalogEntry {
  return {
    packId: 'file_memory',
    packVersion: '0.3.0',
    builtin: false,
    accepted: true,
    sourceId: 'folder',
    kind: 'native',
    connector: 'fs',
    shape: 'document',
    title: null,
    description: null,
    defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: 'manual' },
    availability: 'ready',
    configExample: null,
    credentialHint: null,
    hosts: ['server', 'agent'],
    mcp: null,
    oauth: null,
    records: null,
    ...over,
  }
}

describe('source kinds', () => {
  it('maps connectors to kinds, MCP and external by their kind', () => {
    expect(familyOf({ kind: 'native', connector: 'fs' })).toBe('folder')
    expect(familyOf({ kind: 'native', connector: 's3' })).toBe('bucket')
    expect(familyOf({ kind: 'native', connector: 'url' })).toBe('site')
    expect(familyOf({ kind: 'native', connector: 'git' })).toBe('repo')
    expect(familyOf({ kind: 'mcp', connector: 'mcp' })).toBe('mcp')
    expect(familyOf({ kind: 'external', connector: 'external' })).toBe('external')
    expect(familyOf({ kind: 'native', connector: 'webdav' })).toBe('other')
  })

  it('folds a pack’s document + binary entries of one kind into one card, document first, best availability, ready cards first', () => {
    const cards = cardsOf([
      e({ sourceId: 'bucket_media', connector: 's3', shape: 'binary', availability: 'disabled' }),
      e({ sourceId: 'folder_media', shape: 'binary' }),
      e({ sourceId: 'folder' }),
      e({ sourceId: 'bucket', connector: 's3', availability: 'disabled' }),
      e({ packId: 'code_memory', sourceId: 'repo_docs', connector: 'git', availability: 'agent', hosts: ['agent'] }),
      e({ packId: 'code_memory', sourceId: 'repository', kind: 'external', connector: 'external', shape: 'structure', availability: 'external' }),
    ])
    expect(cards.map((c) => `${c.family}:${c.availability}`)).toEqual([
      'folder:ready',
      'repo:agent',
      'external:external',
      'bucket:disabled',
    ])
    const folder = cards[0]!
    expect(folder.entries.map((x) => x.sourceId)).toEqual(['folder', 'folder_media'])
    expect(shapeChoices(folder)).toEqual(['document', 'binary', 'both'])
    expect(entriesFor(folder, 'document').map((x) => x.sourceId)).toEqual(['folder'])
    expect(entriesFor(folder, 'binary').map((x) => x.sourceId)).toEqual(['folder_media'])
    expect(entriesFor(folder, 'both').map((x) => x.sourceId)).toEqual(['folder', 'folder_media'])
    const repo = cards[1]!
    expect(shapeChoices(repo)).toEqual([])
    expect(entriesFor(repo, null).map((x) => x.sourceId)).toEqual(['repo_docs'])
  })

  it('two packs offering the same kind are told apart by pack; http and stdio MCP are different cards', () => {
    const cards = cardsOf([
      e({ sourceId: 'folder' }),
      e({ packId: 'other_pack', sourceId: 'docs', connector: 'fs' }),
      e({ packId: 'web_memory', sourceId: 'mcp_resources', kind: 'mcp', connector: 'mcp', mcp: { transport: 'http', url: null, auth: 'none', command: null, args: [] } }),
      e({ packId: 'web_memory', sourceId: 'local_mcp', kind: 'mcp', connector: 'mcp', availability: 'agent', hosts: ['agent'], mcp: { transport: 'stdio', url: null, auth: null, command: 'npx', args: [] } }),
    ])
    expect(cards.filter((c) => c.family === 'folder').every((c) => c.ambiguous)).toBe(true)
    expect(cards.filter((c) => c.family === 'mcp')).toHaveLength(2)
    expect(cards.filter((c) => c.family === 'mcp').every((c) => !c.ambiguous)).toBe(true)
  })
})

describe('cloud drives', () => {
  it('each provider is its own kind, two shapes folding into one card', () => {
    const cards = cardsOf([
      e({ sourceId: 'gdrive', connector: 'gdrive', shape: 'document', hosts: ['server'] }),
      e({ sourceId: 'gdrive_media', connector: 'gdrive', shape: 'binary', hosts: ['server'] }),
      e({ sourceId: 'dropbox', connector: 'dropbox', shape: 'document', hosts: ['server'], availability: 'disabled' }),
      e({ sourceId: 'onedrive', connector: 'onedrive', shape: 'document', hosts: ['server'] }),
    ])
    expect(cards.map((c) => c.family)).toEqual(['gdrive', 'onedrive', 'dropbox'])
    expect(familyOf({ kind: 'native', connector: 'onedrive' })).toBe('onedrive')
    const gdrive = cards.find((c) => c.family === 'gdrive')!
    expect(shapeChoices(gdrive)).toEqual(['document', 'binary', 'both'])
    expect(entriesFor(gdrive, 'both').map((x) => x.sourceId)).toEqual(['gdrive', 'gdrive_media'])
  })
})
