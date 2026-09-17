import type { SourceCatalogEntry } from '../../../../lib/contracts/admin-source-connections'

/**
 * The connect form, per connector, as data: which fields an operator
 * fills, how each folds into the connection `config`, and what the
 * credential looks like. The UI renders a spec; the assembly and the
 * validation are pure functions so they are unit-tested without React.
 *
 * Keys are the connectors' own config keys (src/source-plane/connectors)
 * — the JSON view in Advanced shows exactly what the brain receives.
 */

export type FieldType =
  | 'text'
  | 'path'
  | 'url'
  | 'number'
  | 'boolean'
  | 'list'
  | 'select'

export interface FieldSpec {
  key: string
  type: FieldType
  required?: boolean
  /** Folded under "Advanced"; never required. */
  advanced?: boolean
  mono?: boolean
  placeholder?: string
  /** The connector's own default — a boolean equal to it is not sent. */
  default?: boolean
  /** select only */
  options?: string[]
  min?: number
  /** Show only while this holds (values are the live form values). */
  when?: (values: FormValues, ctx: FormContext) => boolean
  /** Not a config key: consumed by `finalize` (e.g. a header name). */
  virtual?: boolean
  /** A path the folder picker can fill (with `include` from ticked subfolders). */
  browse?: boolean
}

export type CredentialSpec =
  | { kind: 'single'; required: (values: FormValues) => boolean; shown: (values: FormValues) => boolean }
  | { kind: 'pair'; required: false; shown: (values: FormValues) => boolean }

export interface ConnectorForm {
  fields: FieldSpec[]
  credential: CredentialSpec | null
  /** Post-assembly hook for keys that are not a 1:1 field (auth scheme). */
  finalize?: (config: Record<string, unknown>, values: FormValues) => Record<string, unknown>
}

export type FormValue = string | boolean
export type FormValues = Record<string, FormValue>

export interface FormContext {
  host: 'server' | 'agent'
  entry: SourceCatalogEntry
  fsRoots: string[]
  egressAllowPrivate: boolean
}

const authHeader: FieldSpec = {
  key: 'authHeader',
  type: 'text',
  mono: true,
  placeholder: 'X-Api-Key',
  virtual: true,
  when: (v) => v['authScheme'] === 'header',
}

const allowPrivate: FieldSpec = {
  key: 'allowPrivate',
  type: 'boolean',
  default: false,
  advanced: true,
  when: (_v, ctx) => ctx.egressAllowPrivate,
}

const FS: ConnectorForm = {
  fields: [
    { key: 'root', type: 'path', required: true, mono: true, placeholder: '/srv/docs', browse: true },
    { key: 'include', type: 'list', mono: true, placeholder: 'docs/**\nnotes/2026\n*.md' },
    { key: 'exclude', type: 'list', mono: true, placeholder: 'docs/archive\n*.log\ndrafts/' },
    { key: 'extensions', type: 'list', mono: true, placeholder: 'md, txt, csv, json, html' },
    {
      key: 'ignoreFiles',
      type: 'list',
      mono: true,
      advanced: true,
      placeholder: '.brainignore\n.gitignore',
    },
    {
      key: 'excludeDirs',
      type: 'list',
      mono: true,
      advanced: true,
      placeholder: '.git, node_modules, dist, build, target, .venv, .cache, .next, coverage',
    },
    { key: 'includeHidden', type: 'boolean', default: false, advanced: true },
    { key: 'maxFiles', type: 'number', min: 1, advanced: true },
    { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
  ],
  credential: null,
}

const URL_FORM: ConnectorForm = {
  fields: [
    { key: 'urls', type: 'list', mono: true, placeholder: 'https://example.com/handbook' },
    { key: 'sitemaps', type: 'list', mono: true, placeholder: 'https://example.com/sitemap.xml' },
    { key: 'sameHostOnly', type: 'boolean', default: true },
    { key: 'maxPages', type: 'number', min: 1, placeholder: '500' },
    {
      key: 'authScheme',
      type: 'select',
      options: ['none', 'bearer', 'basic', 'header'],
      virtual: true,
    },
    authHeader,
    { key: 'refetchHours', type: 'number', min: 1, advanced: true, placeholder: '24' },
    { key: 'delayMs', type: 'number', min: 0, advanced: true },
    { key: 'maxBytes', type: 'number', min: 1, advanced: true },
    { key: 'ignoreRobots', type: 'boolean', default: false, advanced: true },
    allowPrivate,
  ],
  credential: {
    kind: 'single',
    required: (v) => v['authScheme'] !== 'none',
    shown: (v) => v['authScheme'] !== 'none',
  },
  finalize: withAuthScheme,
}

const S3: ConnectorForm = {
  fields: [
    { key: 'bucket', type: 'text', required: true, mono: true, placeholder: 'my-bucket' },
    { key: 'prefix', type: 'text', mono: true, placeholder: 'docs/' },
    { key: 'region', type: 'text', mono: true, placeholder: 'us-east-1' },
    { key: 'endpoint', type: 'url', mono: true, placeholder: 'https://minio.internal:9000' },
    { key: 'forcePathStyle', type: 'boolean', default: false },
    { key: 'extensions', type: 'list', mono: true, advanced: true },
    { key: 'maxObjects', type: 'number', min: 1, advanced: true },
    { key: 'maxObjectBytes', type: 'number', min: 1, advanced: true },
    allowPrivate,
  ],
  credential: { kind: 'pair', required: false, shown: () => true },
}

const MCP_HTTP: ConnectorForm = {
  fields: [
    {
      key: 'url',
      type: 'url',
      required: true,
      mono: true,
      placeholder: 'https://mcp.example.com/mcp',
      when: (_v, ctx) => ctx.entry.mcp?.url === null,
    },
    {
      key: 'authScheme',
      type: 'select',
      options: ['none', 'bearer', 'header'],
      virtual: true,
      when: (_v, ctx) => ctx.entry.mcp?.auth === 'none',
    },
    authHeader,
    { key: 'uriPrefixes', type: 'list', mono: true, placeholder: 'wiki://' },
    { key: 'mimeTypes', type: 'list', mono: true, placeholder: 'text/' },
    { key: 'maxResources', type: 'number', min: 1, advanced: true },
    { key: 'maxBytes', type: 'number', min: 1, advanced: true },
    { key: 'refetchHours', type: 'number', min: 1, advanced: true },
    allowPrivate,
  ],
  credential: {
    kind: 'single',
    required: (v) => v['authScheme'] === 'bearer' || v['authScheme'] === 'header',
    shown: (v) => v['authScheme'] === 'bearer' || v['authScheme'] === 'header',
  },
  finalize: withAuthScheme,
}

const MCP_STDIO: ConnectorForm = { fields: [], credential: null }

const GIT: ConnectorForm = {
  fields: [
    { key: 'repo', type: 'path', required: true, mono: true, placeholder: '/home/me/repo' },
    { key: 'ref', type: 'text', mono: true, placeholder: 'HEAD' },
    { key: 'include', type: 'list', mono: true, placeholder: 'docs/**\nREADME.md' },
    { key: 'extensions', type: 'list', mono: true, advanced: true, placeholder: 'md, txt, rst, adoc' },
    { key: 'maxFiles', type: 'number', min: 1, advanced: true },
    { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
  ],
  credential: null,
}

const EXTERNAL: ConnectorForm = { fields: [], credential: null }

/** `authScheme: none | bearer | basic | header` + `authHeader` → the connector's `authScheme`. */
function withAuthScheme(
  config: Record<string, unknown>,
  values: FormValues,
): Record<string, unknown> {
  const scheme = values['authScheme']
  const out = { ...config }
  delete out['authScheme']
  delete out['authHeader']
  if (scheme === 'basic') out['authScheme'] = 'basic'
  if (scheme === 'header') {
    const name = String(values['authHeader'] ?? '').trim()
    if (name) out['authScheme'] = `header:${name}`
  }
  return out
}

/** The form for an entry, or null when this build knows no form for its connector (JSON editor). */
export function formFor(entry: SourceCatalogEntry): ConnectorForm | null {
  if (entry.kind === 'external') return EXTERNAL
  if (entry.kind === 'mcp') return entry.mcp?.transport === 'stdio' ? MCP_STDIO : MCP_HTTP
  switch (entry.connector) {
    case 'fs':
      return FS
    case 'url':
      return URL_FORM
    case 's3':
      return S3
    case 'git':
      return GIT
    default:
      return null
  }
}

/** Fields the form shows now, in order (required first among the visible non-advanced ones is not reordered — the spec order is the UX order). */
export function visibleFields(
  form: ConnectorForm,
  values: FormValues,
  ctx: FormContext,
  advanced: boolean,
): FieldSpec[] {
  return form.fields.filter((f) => {
    if (f.advanced && !advanced) return false
    return f.when ? f.when(values, ctx) : true
  })
}

/**
 * Initial values: booleans at the connector's default, selects at their
 * first option, everything else empty — the connector's example is a
 * placeholder, never a value the operator has to notice and delete.
 */
export function initialValues(form: ConnectorForm, _entry: SourceCatalogEntry): FormValues {
  const out: FormValues = {}
  for (const f of form.fields) {
    if (f.type === 'boolean') out[f.key] = f.default ?? false
    else if (f.type === 'select') out[f.key] = f.options?.[0] ?? ''
    else out[f.key] = ''
  }
  return out
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** The connection `config` the brain receives: present, non-empty values only. */
export function configFrom(
  form: ConnectorForm,
  values: FormValues,
  ctx: FormContext,
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const f of form.fields) {
    if (f.when && !f.when(values, ctx)) continue
    const v = values[f.key]
    if (f.type === 'boolean') {
      if (typeof v === 'boolean' && v !== (f.default ?? false)) config[f.key] = v
      continue
    }
    const raw = typeof v === 'string' ? v.trim() : ''
    if (raw.length === 0) continue
    if (f.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) config[f.key] = n
    } else if (f.type === 'list') {
      const list = splitList(raw)
      if (list.length > 0) config[f.key] = list
    } else if (f.type === 'select') {
      config[f.key] = raw
    } else {
      config[f.key] = raw
    }
  }
  return form.finalize ? form.finalize(config, values) : config
}

/** The credential string the brain stores: a bearer / token, or `accessKeyId:secretAccessKey`. */
export function credentialFrom(
  form: ConnectorForm,
  secret: { single: string; keyId: string; keySecret: string },
): string | undefined {
  if (!form.credential) return undefined
  if (form.credential.kind === 'pair') {
    const id = secret.keyId.trim()
    const key = secret.keySecret.trim()
    if (!id && !key) return undefined
    return `${id}:${key}`
  }
  return secret.single.length > 0 ? secret.single : undefined
}

export type FieldError = 'required' | 'path' | 'url' | 'number' | 'credential' | 'header' | 'jail'

/** Field-level errors, keyed by field (or `credential`); empty = the step may proceed. */
export function validate(
  form: ConnectorForm,
  values: FormValues,
  ctx: FormContext,
  secret: { single: string; keyId: string; keySecret: string },
): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {}
  for (const f of form.fields) {
    if (f.when && !f.when(values, ctx)) continue
    const v = values[f.key]
    const raw = typeof v === 'string' ? v.trim() : ''
    if (f.required && raw.length === 0) {
      errors[f.key] = 'required'
      continue
    }
    if (raw.length === 0) continue
    if (f.type === 'path' && !raw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(raw)) errors[f.key] = 'path'
    if (f.type === 'path' && f.key === 'root' && ctx.host === 'server' && ctx.fsRoots.length > 0) {
      const inside = ctx.fsRoots.some((r) => raw === r || raw.startsWith(r.endsWith('/') ? r : `${r}/`))
      if (!inside) errors[f.key] = 'jail'
    }
    if (f.type === 'url' && !isHttpUrl(raw)) errors[f.key] = 'url'
    if (f.type === 'list' && (f.key === 'urls' || f.key === 'sitemaps')) {
      if (splitList(raw).some((u) => !isHttpUrl(u))) errors[f.key] = 'url'
    }
    if (f.type === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n) || (f.min !== undefined && n < f.min)) errors[f.key] = 'number'
    }
  }
  if (form.fields.some((f) => f.key === 'urls') && form.fields.some((f) => f.key === 'sitemaps')) {
    const urls = String(values['urls'] ?? '').trim()
    const sitemaps = String(values['sitemaps'] ?? '').trim()
    if (!urls && !sitemaps) errors['urls'] = 'required'
  }
  if (values['authScheme'] === 'header' && !String(values['authHeader'] ?? '').trim()) {
    errors['authHeader'] = 'header'
  }
  if (form.credential?.kind === 'single' && form.credential.required(values) && !secret.single) {
    errors['credential'] = 'credential'
  }
  if (form.credential?.kind === 'pair') {
    const id = secret.keyId.trim()
    const key = secret.keySecret.trim()
    if ((id && !key) || (!id && key)) errors['credential'] = 'credential'
  }
  return errors
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
