import { describe, expect, it } from 'vitest'
import {
  configFrom,
  credentialFrom,
  formFor,
  initialValues,
  validate,
  visibleFields,
  type FormContext,
  type FormValues,
} from '@/components/admin/connections/create/specs'
import type { SourceCatalogEntry } from '@/lib/contracts/admin-source-connections'

/**
 * The connect form as data: each connector's fields fold into exactly
 * the config the brain's connector reads, validation refuses what the
 * brain would refuse (with the field named), and nothing empty is sent.
 */

function entry(over: Partial<SourceCatalogEntry>): SourceCatalogEntry {
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
    configExample: { root: '/srv/docs', excludeDirs: ['.git', 'node_modules'] },
    credentialHint: null,
    hosts: ['server', 'agent'],
    mcp: null,
    oauth: null,
    ...over,
  }
}

const noSecret = { single: '', keyId: '', keySecret: '', grantId: '' }

function ctxFor(e: SourceCatalogEntry, over: Partial<FormContext> = {}): FormContext {
  return { host: 'server', entry: e, fsRoots: [], egressAllowPrivate: false, ...over }
}

describe('connect form specs', () => {
  it('fs: the root is typed by the operator, lists split on newlines or commas, booleans only when they differ', () => {
    const e = entry({})
    const form = formFor(e)!
    const values = initialValues(form, e)
    expect(values['root']).toBe('') // the example is a placeholder, never a value
    expect(values['excludeDirs']).toBe('')
    expect(configFrom(form, values, ctxFor(e))).toEqual({})
    values['root'] = '/srv/handbook'
    values['include'] = 'docs/**\n/README.md'
    values['exclude'] = 'docs/archive'
    values['extensions'] = 'md, txt'
    values['ignoreFiles'] = '.brainignore\n.gitignore'
    values['excludeDirs'] = '.git\nnode_modules'
    values['includeHidden'] = false
    values['maxFiles'] = '200'
    expect(configFrom(form, values, ctxFor(e))).toEqual({
      root: '/srv/handbook',
      include: ['docs/**', '/README.md'],
      exclude: ['docs/archive'],
      extensions: ['md', 'txt'],
      ignoreFiles: ['.brainignore', '.gitignore'],
      excludeDirs: ['.git', 'node_modules'],
      maxFiles: 200,
    })
    values['includeHidden'] = true
    expect(configFrom(form, values, ctxFor(e))['includeHidden']).toBe(true)
  })

  it('fs: the jail is checked on the brain, not on an agent; a relative path is refused', () => {
    const e = entry({})
    const form = formFor(e)!
    const values: FormValues = { ...initialValues(form, e), root: '/home/me/docs' }
    const jailed = ctxFor(e, { fsRoots: ['/srv'] })
    expect(validate(form, values, jailed, noSecret)).toEqual({ root: 'jail' })
    expect(validate(form, { ...values, root: '/srv/docs' }, jailed, noSecret)).toEqual({})
    expect(validate(form, values, ctxFor(e, { host: 'agent', fsRoots: ['/srv'] }), noSecret)).toEqual({})
    expect(validate(form, { ...values, root: 'docs' }, ctxFor(e), noSecret)).toEqual({ root: 'path' })
    expect(validate(form, { ...values, root: '' }, ctxFor(e), noSecret)).toEqual({ root: 'required' })
    expect(validate(form, { ...values, maxFiles: '0' }, ctxFor(e), noSecret)).toEqual({ maxFiles: 'number' })
  })

  it('url: pages or a sitemap is required, every one an http(s) URL; the auth scheme folds into config and demands a token', () => {
    const e = entry({ packId: 'web_memory', sourceId: 'site', connector: 'url', configExample: null, hosts: ['server'] })
    const form = formFor(e)!
    const values = initialValues(form, e)
    expect(values['sameHostOnly']).toBe(true)
    expect(values['authScheme']).toBe('none')
    expect(validate(form, values, ctxFor(e), noSecret)).toEqual({ urls: 'required' })
    values['sitemaps'] = 'https://example.com/sitemap.xml\nftp://nope'
    expect(validate(form, values, ctxFor(e), noSecret)).toEqual({ sitemaps: 'url' })
    values['sitemaps'] = 'https://example.com/sitemap.xml'
    values['sameHostOnly'] = false
    values['authScheme'] = 'header'
    expect(validate(form, values, ctxFor(e), noSecret)).toEqual({ authHeader: 'header', credential: 'credential' })
    values['authHeader'] = 'X-Api-Key'
    expect(validate(form, values, ctxFor(e), { ...noSecret, single: 'tok' })).toEqual({})
    expect(configFrom(form, values, ctxFor(e))).toEqual({
      sitemaps: ['https://example.com/sitemap.xml'],
      sameHostOnly: false,
      authScheme: 'header:X-Api-Key',
    })
    values['authScheme'] = 'bearer'
    expect(configFrom(form, values, ctxFor(e))['authScheme']).toBeUndefined() // the connector's default
    expect(credentialFrom(form, { ...noSecret, single: 'tok' })).toBe('tok')
    // The token field is only offered once an auth is chosen.
    const cred = form.credential!
    if (cred.kind === 'oauth') throw new Error('url takes a token, not an account')
    expect(cred.shown({ ...values, authScheme: 'none' })).toBe(false)
    expect(cred.shown(values)).toBe(true)
  })

  it('url: allowPrivate is offered only when the deployment opted in, and only under Advanced', () => {
    const e = entry({ connector: 'url', configExample: null, hosts: ['server'] })
    const form = formFor(e)!
    const values = initialValues(form, e)
    const keys = (ctx: FormContext, advanced: boolean) => visibleFields(form, values, ctx, advanced).map((f) => f.key)
    expect(keys(ctxFor(e), true)).not.toContain('allowPrivate')
    expect(keys(ctxFor(e, { egressAllowPrivate: true }), false)).not.toContain('allowPrivate')
    expect(keys(ctxFor(e, { egressAllowPrivate: true }), true)).toContain('allowPrivate')
  })

  it('s3: the credential pair joins as accessKeyId:secretAccessKey, both or neither', () => {
    const e = entry({ sourceId: 'bucket', connector: 's3', configExample: null, hosts: ['server'] })
    const form = formFor(e)!
    const values: FormValues = { ...initialValues(form, e), bucket: 'docs', endpoint: 'not a url' }
    expect(validate(form, values, ctxFor(e), noSecret)).toEqual({ endpoint: 'url' })
    values['endpoint'] = 'https://minio.internal:9000'
    values['forcePathStyle'] = true
    expect(configFrom(form, values, ctxFor(e))).toEqual({
      bucket: 'docs',
      endpoint: 'https://minio.internal:9000',
      forcePathStyle: true,
    })
    expect(validate(form, values, ctxFor(e), { ...noSecret, keyId: 'AKIA' })).toEqual({ credential: 'credential' })
    expect(credentialFrom(form, noSecret)).toBeUndefined()
    expect(credentialFrom(form, { ...noSecret, keyId: 'AKIA', keySecret: 's3cr3t' })).toBe('AKIA:s3cr3t')
  })

  it('cloud drives: the credential is a connected account — required on the brain, oauth:<grant> on the wire', () => {
    const gdrive = entry({
      sourceId: 'gdrive',
      connector: 'gdrive',
      configExample: { folderId: 'root' },
      hosts: ['server'],
      oauth: { provider: 'google', title: 'Google', scopes: ['https://www.googleapis.com/auth/drive.readonly'], configured: true },
    })
    const form = formFor(gdrive)!
    expect(form.credential).toEqual({ kind: 'oauth' })
    const values = initialValues(form, gdrive)
    expect(visibleFields(form, values, ctxFor(gdrive), false).map((f) => f.key)).toEqual([
      'folderId',
      'includeShared',
      'extensions',
    ])
    expect(validate(form, values, ctxFor(gdrive), noSecret)).toEqual({ credential: 'account' })
    expect(credentialFrom(form, noSecret)).toBeUndefined()
    const picked = { ...noSecret, grantId: 'source_oauth_grant:g1' }
    expect(validate(form, values, ctxFor(gdrive), picked)).toEqual({})
    expect(credentialFrom(form, picked)).toBe('oauth:source_oauth_grant:g1')
    values['folderId'] = '1AbC'
    values['includeShared'] = true
    expect(configFrom(form, values, ctxFor(gdrive))).toEqual({ folderId: '1AbC', includeShared: true })

    const onedrive = entry({ sourceId: 'onedrive', connector: 'onedrive', hosts: ['server'], oauth: { provider: 'microsoft', title: 'Microsoft', scopes: [], configured: false } })
    const of = formFor(onedrive)!
    const ov: FormValues = { ...initialValues(of, onedrive), folderPath: '/Documents/Team' }
    expect(configFrom(of, ov, ctxFor(onedrive))).toEqual({ folderPath: '/Documents/Team' })
    const dropbox = entry({ sourceId: 'dropbox', connector: 'dropbox', hosts: ['server'], oauth: { provider: 'dropbox', title: 'Dropbox', scopes: [], configured: true } })
    const df = formFor(dropbox)!
    expect(visibleFields(df, initialValues(df, dropbox), ctxFor(dropbox), true).map((f) => f.key)).toEqual([
      'path',
      'extensions',
      'maxFiles',
      'maxFileBytes',
    ])
  })

  it('mcp over http: a named server asks for the url, a pinned one does not; install_secret hides auth', () => {
    const named = entry({
      packId: 'web_memory',
      sourceId: 'mcp_resources',
      kind: 'mcp',
      connector: 'mcp',
      configExample: null,
      hosts: ['server'],
      mcp: { transport: 'http', url: null, auth: 'none', command: null, args: [] },
    })
    const form = formFor(named)!
    const values = initialValues(form, named)
    expect(visibleFields(form, values, ctxFor(named), false).map((f) => f.key)).toEqual([
      'url',
      'authScheme',
      'uriPrefixes',
      'mimeTypes',
    ])
    expect(validate(form, values, ctxFor(named), noSecret)).toEqual({ url: 'required' })
    values['url'] = 'https://mcp.example.com/mcp'
    values['uriPrefixes'] = 'wiki://'
    expect(configFrom(form, values, ctxFor(named))).toEqual({ url: 'https://mcp.example.com/mcp', uriPrefixes: ['wiki://'] })

    const pinned = entry({
      ...named,
      mcp: { transport: 'http', url: 'https://mcp.example.com/mcp', auth: 'install_secret', command: null, args: [] },
    })
    const pinnedForm = formFor(pinned)!
    const pv = initialValues(pinnedForm, pinned)
    expect(visibleFields(pinnedForm, pv, ctxFor(pinned), false).map((f) => f.key)).toEqual(['uriPrefixes', 'mimeTypes'])
    expect(validate(pinnedForm, pv, ctxFor(pinned), noSecret)).toEqual({})
    expect(configFrom(pinnedForm, pv, ctxFor(pinned))).toEqual({})
  })

  it('git on an agent: repo path, globs one per line; stdio MCP and external entries have no fields; an unknown connector has no form', () => {
    const git = entry({ packId: 'code_memory', sourceId: 'repo_docs', connector: 'git', configExample: null, hosts: ['agent'] })
    const form = formFor(git)!
    const values: FormValues = { ...initialValues(form, git), repo: '/home/me/repo', include: 'docs/**\nREADME.md' }
    expect(validate(form, values, ctxFor(git, { host: 'agent' }), noSecret)).toEqual({})
    expect(configFrom(form, values, ctxFor(git, { host: 'agent' }))).toEqual({ repo: '/home/me/repo', include: ['docs/**', 'README.md'] })
    const stdio = entry({
      kind: 'mcp',
      connector: 'mcp',
      hosts: ['agent'],
      mcp: { transport: 'stdio', url: null, auth: null, command: 'npx', args: ['-y', 'x'] },
    })
    expect(formFor(stdio)!.fields).toEqual([])
    expect(formFor(entry({ kind: 'external', connector: 'external', hosts: ['server'] }))!.fields).toEqual([])
    expect(formFor(entry({ connector: 'webdav' }))).toBeNull()
  })
})
