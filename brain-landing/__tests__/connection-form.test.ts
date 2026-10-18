import { describe, expect, it } from 'vitest'
import {
  configFrom,
  credentialFrom,
  dbEntitiesError,
  dbProposalOf,
  formFor,
  initialValues,
  validate,
  isJwtBearer,
  parseDbEntities,
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
    records: null,
    webhook: null,
    ...over,
  }
}

const noSecret = { single: '', keyId: '', keySecret: '', grantId: '' }

function ctxFor(e: SourceCatalogEntry, over: Partial<FormContext> = {}): FormContext {
  return { host: 'server', entry: e, fsRoots: [], egressAllowPrivate: false, ...over }
}

describe('connect form specs', () => {
  it('a forge shows only the half being connected — and both halves under "Both"', () => {
    const issues = entry({
      packId: 'code_memory',
      sourceId: 'gitlab_issues',
      connector: 'gitlab',
      shape: 'conversation',
    })
    const docs = entry({
      packId: 'code_memory',
      sourceId: 'gitlab_docs',
      connector: 'gitlab',
      shape: 'document',
    })
    const form = formFor(issues)!
    const keysFor = (ctx: FormContext) =>
      visibleFields(form, initialValues(form, issues), ctx, true).map((f) => f.key)
    expect(keysFor(ctxFor(issues))).toEqual([
      'project',
      'since',
      'includeMergeRequests',
      'labels',
      'baseUrl',
      'maxItems',
    ])
    expect(keysFor(ctxFor(docs))).toEqual([
      'project',
      'paths',
      'ref',
      'baseUrl',
      'extensions',
      'maxFiles',
      'maxFileBytes',
    ])
    // "Both" creates a connection per shape from ONE form: every field
    // either half needs has to be on it.
    const both = keysFor(ctxFor(docs, { shapes: ['document', 'conversation'] }))
    expect(both).toContain('since')
    expect(both).toContain('paths')
  })

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

  it('CRM vendors: HubSpot, Bitrix24 and Kommo as an account or a pasted alternative (a token, the webhook URL, a long-lived token with the account URL)', () => {
    const hubspot = entry({
      packId: 'crm_memory',
      sourceId: 'hubspot',
      connector: 'hubspot',
      shape: 'structure',
      hosts: ['server'],
      credentialHint: 'a connected HubSpot account (oauth:<grant id>), or a private-app access token',
      oauth: { provider: 'hubspot', title: 'HubSpot', scopes: ['crm.objects.deals.read'], configured: false },
    })
    const hf = formFor(hubspot)!
    expect(hf.credential).toEqual({ kind: 'oauth', alternative: 'token' })
    expect(visibleFields(hf, initialValues(hf, hubspot), ctxFor(hubspot), true)).toEqual([])
    expect(validate(hf, {}, ctxFor(hubspot), noSecret)).toEqual({ credential: 'account' })
    expect(credentialFrom(hf, { ...noSecret, single: 'pat-na1-x' })).toBe('pat-na1-x')
    expect(validate(hf, {}, ctxFor(hubspot), { ...noSecret, single: 'pat-na1-x' })).toEqual({})

    // Bitrix24 (W4.3b): a connected account, or the inbound webhook URL pasted as the alternative.
    const picked = { ...noSecret, grantId: 'source_oauth_grant:g1' }
    const bitrix = entry({
      packId: 'crm_memory',
      sourceId: 'bitrix24',
      connector: 'bitrix24',
      shape: 'structure',
      hosts: ['server'],
      oauth: { provider: 'bitrix24', title: 'Bitrix24', scopes: ['crm', 'user'], configured: false },
    })
    const bf = formFor(bitrix)!
    expect(bf.credential).toEqual({ kind: 'oauth', alternative: 'webhookUrl' })
    const bv = initialValues(bf, bitrix)
    expect(visibleFields(bf, bv, ctxFor(bitrix), true).map((f) => f.key)).toEqual([])
    expect(visibleFields(bf, bv, ctxFor(bitrix, { egressAllowPrivate: true }), true).map((f) => f.key)).toEqual(['allowPrivate'])
    expect(validate(bf, bv, ctxFor(bitrix), noSecret)).toEqual({ credential: 'account' })
    const hook = { ...noSecret, single: 'https://acme.bitrix24.ru/rest/1/abc/' }
    expect(validate(bf, bv, ctxFor(bitrix), hook)).toEqual({})
    expect(credentialFrom(bf, hook)).toBe('https://acme.bitrix24.ru/rest/1/abc/')
    expect(validate(bf, bv, ctxFor(bitrix), picked)).toEqual({})
    expect(credentialFrom(bf, picked)).toBe('oauth:source_oauth_grant:g1')
    expect(configFrom(bf, { ...bv, allowPrivate: true }, ctxFor(bitrix, { egressAllowPrivate: true }))).toEqual({ allowPrivate: true })

    // Kommo (W4.3b): a connected account names the host; a long-lived token needs baseUrl.
    const kommo = entry({
      packId: 'crm_memory',
      sourceId: 'kommo',
      connector: 'kommo',
      shape: 'structure',
      hosts: ['server'],
      oauth: { provider: 'kommo', title: 'Kommo / amoCRM', scopes: [], configured: false },
    })
    const kf = formFor(kommo)!
    expect(kf.credential).toEqual({ kind: 'oauth', alternative: 'longLivedToken' })
    const kv = initialValues(kf, kommo)
    expect(validate(kf, kv, ctxFor(kommo), noSecret)).toEqual({ baseUrl: 'required', credential: 'account' })
    expect(validate(kf, kv, ctxFor(kommo), { ...noSecret, single: 't' })).toEqual({ baseUrl: 'required' })
    expect(validate(kf, kv, ctxFor(kommo), picked)).toEqual({})
    expect(validate(kf, { ...kv, baseUrl: 'acme.kommo.com' }, ctxFor(kommo), { ...noSecret, single: 't' })).toEqual({ baseUrl: 'url' })
    expect(configFrom(kf, { ...kv, baseUrl: 'https://acme.kommo.com' }, ctxFor(kommo))).toEqual({ baseUrl: 'https://acme.kommo.com' })
  })

  it('an MCP server that signs in: the operator-named URL, no auth scheme, the credential is the grant at that server', () => {
    const signedIn = entry({
      packId: 'signed_wiki',
      sourceId: 'wiki',
      kind: 'mcp',
      connector: 'mcp',
      hosts: ['server'],
      mcp: { transport: 'http', url: null, auth: 'oauth', command: null, args: [] },
      oauth: { provider: 'mcp', title: 'the MCP server', scopes: [], configured: true },
    })
    const form = formFor(signedIn)!
    expect(form.credential).toEqual({ kind: 'oauth' })
    const values = initialValues(form, signedIn)
    expect(visibleFields(form, values, ctxFor(signedIn), false).map((f) => f.key)).toEqual(['url', 'uriPrefixes', 'mimeTypes'])
    expect(validate(form, values, ctxFor(signedIn), noSecret)).toEqual({ url: 'required', credential: 'account' })
    expect(validate(form, { ...values, url: 'https://mcp.example.test/mcp' }, ctxFor(signedIn), { ...noSecret, grantId: 'source_oauth_grant:g1' })).toEqual({})
    expect(configFrom(form, { ...values, url: 'https://mcp.example.test/mcp' }, ctxFor(signedIn))).toEqual({ url: 'https://mcp.example.test/mcp' })
  })

  it('Salesforce: a connected account or a JWT bearer JSON (validated as such); the org, login host, version and bulk walk are advanced', () => {
    const sf = entry({
      packId: 'crm_memory',
      sourceId: 'salesforce',
      connector: 'salesforce',
      shape: 'structure',
      hosts: ['server'],
      oauth: { provider: 'salesforce', title: 'Salesforce', scopes: ['api'], configured: true },
    })
    const form = formFor(sf)!
    expect(form.credential).toEqual({ kind: 'oauth', alternative: 'jwtBearer' })
    const values = initialValues(form, sf)
    expect(visibleFields(form, values, ctxFor(sf), false)).toEqual([])
    expect(visibleFields(form, values, ctxFor(sf), true).map((f) => f.key)).toEqual(['instanceUrl', 'loginUrl', 'apiVersion', 'bulk'])
    expect(validate(form, values, ctxFor(sf), noSecret)).toEqual({ credential: 'account' })
    expect(validate(form, values, ctxFor(sf), { ...noSecret, grantId: 'source_oauth_grant:g1' })).toEqual({})
    expect(credentialFrom(form, { ...noSecret, grantId: 'source_oauth_grant:g1' })).toBe('oauth:source_oauth_grant:g1')
    expect(validate(form, values, ctxFor(sf), { ...noSecret, single: 'not json' })).toEqual({ credential: 'jwtBearer' })
    expect(validate(form, values, ctxFor(sf), { ...noSecret, single: '{"clientId":"k","username":"u"}' })).toEqual({ credential: 'jwtBearer' })
    const jwt = JSON.stringify({ clientId: 'k', username: 'u@acme.test', privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' })
    expect(validate(form, values, ctxFor(sf), { ...noSecret, single: ` ${jwt} ` })).toEqual({})
    expect(credentialFrom(form, { ...noSecret, single: ` ${jwt} ` })).toBe(jwt)
    expect(isJwtBearer(jwt)).toBe(true)
    expect(validate(form, { ...values, instanceUrl: 'acme.my.salesforce.com' }, ctxFor(sf), { ...noSecret, single: jwt })).toEqual({ instanceUrl: 'url' })
    expect(configFrom(form, { ...values, instanceUrl: 'https://acme.my.salesforce.com', bulk: true, apiVersion: 'v62.0' }, ctxFor(sf))).toEqual({
      instanceUrl: 'https://acme.my.salesforce.com',
      apiVersion: 'v62.0',
      bulk: true,
    })
  })

  it('custom REST: base URL required, the credential rides as chosen (header / query names required), none needs no credential', () => {
    const custom = entry({ packId: 'crm_memory', sourceId: 'custom', connector: 'rest_records', shape: 'structure', hosts: ['server'] })
    const form = formFor(custom)!
    const values = initialValues(form, custom)
    expect(values['authScheme']).toBe('bearer')
    expect(visibleFields(form, values, ctxFor(custom), false).map((f) => f.key)).toEqual(['baseUrl', 'authScheme'])
    expect(validate(form, values, ctxFor(custom), noSecret)).toEqual({ baseUrl: 'required', credential: 'credential' })
    const header = { ...values, baseUrl: 'https://crm.example.com/api', authScheme: 'header' }
    expect(visibleFields(form, header, ctxFor(custom), false).map((f) => f.key)).toEqual(['baseUrl', 'authScheme', 'authHeader'])
    expect(validate(form, header, ctxFor(custom), { ...noSecret, single: 'k' })).toEqual({ authHeader: 'header' })
    expect(configFrom(form, { ...header, authHeader: 'X-Api-Key' }, ctxFor(custom))).toEqual({
      baseUrl: 'https://crm.example.com/api',
      authScheme: 'header:X-Api-Key',
    })
    const query = { ...header, authScheme: 'query', authParam: 'api_key' }
    expect(configFrom(form, query, ctxFor(custom))).toEqual({ baseUrl: 'https://crm.example.com/api', authScheme: 'query:api_key' })
    expect(validate(form, { ...query, authParam: '' }, ctxFor(custom), { ...noSecret, single: 'k' })).toEqual({ authParam: 'header' })
    const none = { ...header, authScheme: 'none' }
    expect(validate(form, none, ctxFor(custom), noSecret)).toEqual({})
    expect(configFrom(form, none, ctxFor(custom))).toEqual({ baseUrl: 'https://crm.example.com/api', authScheme: 'none' })
    expect(credentialFrom(form, { ...noSecret, single: 'k' })).toBe('k')
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

/**
 * A database on the agent (W4.4): the form asks for the database's name
 * and the tables as record types — never a connection string — and the
 * tables become the brain's `config.entities`; the listed columns are
 * what the mapping table offers.
 */
describe('db source form', () => {
  const db = entry({
    packId: 'crm_memory',
    sourceId: 'db',
    connector: 'db',
    shape: 'structure',
    hosts: ['agent'],
    records: { entities: [], preset: {}, predicates: [{ localId: 'deal_stage', label: 'deal stage' }] },
  })
  const drafts = JSON.stringify([
    { type: 'deal', table: 'deals_v', idColumn: '', nameColumn: 'title', updatedAtColumn: 'updated_at', columns: 'stage, amount', relations: 'organization = company_id -> organization' },
    { type: 'organization', table: 'crm.companies', idColumn: 'id', nameColumn: '', updatedAtColumn: '', columns: '', relations: '' },
  ])

  it('asks for the database name and at least one valid table; the generic field list shows only the advanced limits', () => {
    const form = formFor(db)!
    expect(form.credential).toBeNull()
    expect(visibleFields(form, initialValues(form, db), ctxFor(db), false)).toEqual([])
    expect(visibleFields(form, initialValues(form, db), ctxFor(db), true).map((f) => f.key)).toEqual(['pageSize', 'maxRows'])
    expect(validate(form, {}, { ...ctxFor(db), host: 'agent' }, noSecret)).toEqual({ database: 'required', entities: 'required' })
    expect(dbEntitiesError('[]')).toBe('required')
    expect(dbEntitiesError(JSON.stringify([{ type: 'deal', table: 'deals; drop table x' }]))).toBe('identifier')
    expect(dbEntitiesError(JSON.stringify([{ type: 'deal', table: 'deals', columns: 'a, b c' }]))).toBe('identifier')
    expect(dbEntitiesError(JSON.stringify([{ type: 'deal', table: 'deals', relations: 'org company_id' }]))).toBe('identifier')
    expect(dbEntitiesError(drafts)).toBeNull()
    expect(validate(form, { database: 'crm', entities: drafts }, { ...ctxFor(db), host: 'agent' }, noSecret)).toEqual({})
  })

  it('assembles config.entities from the drafts — blanks left out, columns split, relations parsed — and never a DSN', () => {
    const form = formFor(db)!
    const config = configFrom(form, { database: 'crm', entities: drafts, pageSize: '500' }, { ...ctxFor(db), host: 'agent' })
    expect(config).toEqual({
      database: 'crm',
      pageSize: 500,
      entities: [
        {
          type: 'deal',
          table: 'deals_v',
          nameColumn: 'title',
          updatedAtColumn: 'updated_at',
          columns: ['stage', 'amount'],
          relations: [{ kind: 'organization', column: 'company_id', targetType: 'organization' }],
        },
        { type: 'organization', table: 'crm.companies', idColumn: 'id' },
      ],
    })
    expect(JSON.stringify(config)).not.toMatch(/dsn|password/)
    expect(parseDbEntities('not json')).toEqual([])
    expect(dbProposalOf(drafts)).toEqual([
      { type: 'deal', label: 'deal', source: 'operator', confidence: 1, reason: 'deals_v', fields: [{ key: 'stage', label: 'stage' }, { key: 'amount', label: 'amount' }] },
      { type: 'organization', label: 'organization', source: 'operator', confidence: 1, reason: 'crm.companies', fields: [] },
    ])
  })
})
