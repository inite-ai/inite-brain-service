import { describe, expect, it } from 'vitest'
import {
  SOURCE_GROUPS,
  cardsOf,
  entriesFor,
  familyOf,
  groupCards,
  groupConnections,
  groupOf,
  matchesQuery,
  cardWords,
  shapeChoices,
} from '@/components/admin/connections/kinds'
import type { SourceCatalogEntry, SourceConnection } from '@/lib/contracts/admin-source-connections'

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
    webhook: null,
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

function conn(over: Partial<SourceConnection>): SourceConnection {
  return {
    id: `source_connection:${over.sourceId ?? 'x'}`,
    packId: 'file_memory',
    sourceId: 'folder',
    kind: 'native',
    connector: 'fs',
    shape: 'document',
    host: 'server',
    label: null,
    config: {},
    hasCredential: false,
    grantId: null,
    mode: 'synced',
    schedule: 'manual',
    contentPolicy: 'text',
    deletePolicy: 'close',
    fetchBudget: null,
    status: 'active',
    checkpoint: null,
    vertical: 'file_memory',
    recorder: 'file_memory',
    sourceKey: 'k',
    ownerUserId: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    webhook: { enabled: false, lastEventAt: null },
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: null,
    ...over,
  }
}

/**
 * Seventeen cards and a dozen connections in one heap is what the page
 * used to be; both fold by source group now, in one fixed order, and
 * every family lands in exactly one group.
 */
describe('source groups', () => {
  it('every family has a group; the drives sit with folders and buckets, the CRMs together', () => {
    expect(groupOf('folder')).toBe('files')
    expect(groupOf('bucket')).toBe('files')
    expect(groupOf('gdrive')).toBe('files')
    expect(groupOf('onedrive')).toBe('files')
    expect(groupOf('dropbox')).toBe('files')
    expect(groupOf('site')).toBe('web')
    expect(groupOf('mcp')).toBe('mcp')
    expect(groupOf('repo')).toBe('code')
    expect(groupOf('records')).toBe('records')
    expect(groupOf('external')).toBe('external')
    expect(groupOf('other')).toBe('other')
    expect(SOURCE_GROUPS).toEqual(['files', 'web', 'mcp', 'code', 'records', 'external', 'other'])
  })

  it('the catalogue folds by group in page order, empty groups absent, ready cards first inside a group', () => {
    const groups = groupCards(
      cardsOf([
        e({ packId: 'crm_memory', sourceId: 'hubspot', connector: 'hubspot', shape: 'structure' }),
        e({ packId: 'crm_memory', sourceId: 'push', kind: 'external', connector: 'external', shape: 'structure', availability: 'external' }),
        e({ sourceId: 'bucket', connector: 's3', availability: 'disabled' }),
        e({ sourceId: 'folder' }),
        e({ packId: 'web_memory', sourceId: 'mcp_resources', kind: 'mcp', connector: 'mcp', mcp: { transport: 'http', url: null, auth: 'none', command: null, args: [] } }),
        e({ packId: 'web_memory', sourceId: 'site', connector: 'url' }),
      ]),
    )
    expect(groups.map((g) => `${g.group}:${g.items.map((c) => c.family).join(',')}`)).toEqual([
      'files:folder,bucket',
      'web:site',
      'mcp:mcp',
      'records:records',
      'external:external',
    ])
  })

  it('connections fold the same way, alphabetical by label inside a group; the filter reads label, pack, source, connector and host', () => {
    const rows = [
      conn({ sourceId: 'kommo', packId: 'crm_memory', connector: 'kommo', shape: 'structure', label: 'Kommo (token)' }),
      conn({ sourceId: 'folder_media', shape: 'binary', label: 'Handbook media' }),
      conn({ sourceId: 'repo_docs', packId: 'code_memory', connector: 'git', host: 'agent:mikes-mac', label: 'brain repo docs' }),
      conn({ sourceId: 'folder', label: 'Payments handbook' }),
      conn({ sourceId: 'gdrive', connector: 'gdrive', label: 'Finance drive' }),
      conn({ sourceId: 'wiki', packId: 'signed_wiki', kind: 'mcp', connector: 'mcp', label: null }),
    ]
    const groups = groupConnections(rows)
    expect(groups.map((g) => `${g.group}:${g.items.map((c) => c.label ?? `${c.packId}/${c.sourceId}`).join('|')}`)).toEqual([
      'files:Finance drive|Handbook media|Payments handbook',
      'mcp:signed_wiki/wiki',
      'code:brain repo docs',
      'records:Kommo (token)',
    ])
    expect(rows.filter((c) => matchesQuery(c, 'handbook')).map((c) => c.sourceId)).toEqual(['folder_media', 'folder'])
    expect(rows.filter((c) => matchesQuery(c, 'MIKES')).map((c) => c.sourceId)).toEqual(['repo_docs'])
    expect(rows.filter((c) => matchesQuery(c, 'signed_wiki')).map((c) => c.sourceId)).toEqual(['wiki'])
    expect(rows.filter((c) => matchesQuery(c, 'gdrive')).map((c) => c.sourceId)).toEqual(['gdrive'])
    expect(rows.filter((c) => matchesQuery(c, '   ')).length).toBe(rows.length)
  })
})

describe('card words', () => {
  const words = { title: 'CRM · Pipedrive', body: 'generic records body' }
  it('a vendor card carries the pack’s description without the config tail; a generic kind keeps the page’s words', () => {
    const [pipedrive] = cardsOf([
      e({
        packId: 'crm_memory',
        sourceId: 'pipedrive',
        connector: 'pipedrive',
        shape: 'structure',
        title: 'Pipedrive',
        description: 'Deals, persons and organizations of a Pipedrive account, as a connected account or with an API token. config: { entities?, mapping? }.',
      }),
    ])
    expect(cardWords(pipedrive!, words)).toEqual({
      title: 'CRM · Pipedrive',
      body: 'Deals, persons and organizations of a Pipedrive account, as a connected account or with an API token.',
    })
    const [folder] = cardsOf([e({ description: 'Text-like files under a directory. config: { root }.' })])
    expect(cardWords(folder!, { title: 'Folder', body: 'A directory of documents.' })).toEqual({
      title: 'Folder',
      body: 'A directory of documents.',
    })
  })

  it('a push door is named by the pack — two “pushed by a publisher” cards are told apart', () => {
    const [door] = cardsOf([
      e({
        packId: 'crm_memory',
        sourceId: 'push',
        kind: 'external',
        connector: 'external',
        shape: 'structure',
        availability: 'external',
        title: 'Pushed records (webhook / automation)',
        description: 'Record envelopes posted by a CRM outbound webhook or an automation. config: { mapping? }.',
      }),
    ])
    expect(cardWords(door!, { title: 'Pushed by a publisher', body: 'generic' })).toEqual({
      title: 'Pushed records (webhook / automation)',
      body: 'Record envelopes posted by a CRM outbound webhook or an automation.',
    })
  })
})
