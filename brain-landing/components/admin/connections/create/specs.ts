import type { SourceCatalogEntry } from '../../../../lib/contracts/admin-source-connections';

/**
 * The connect form, per connector, as data: which fields an operator
 * fills, how each folds into the connection `config`, and what the
 * credential looks like. The UI renders a spec; the assembly and the
 * validation are pure functions so they are unit-tested without React.
 *
 * Keys are the connectors' own config keys (src/source-plane/connectors)
 * — the JSON view in Advanced shows exactly what the brain receives.
 */

export type FieldType = 'text' | 'path' | 'url' | 'number' | 'boolean' | 'list' | 'select';

export interface FieldSpec {
  key: string;
  type: FieldType;
  required?: boolean;
  /** Required unless a connected account is chosen — the account names it (Kommo's host). */
  requiredWithoutGrant?: boolean;
  /** Folded under "Advanced"; never required. */
  advanced?: boolean;
  mono?: boolean;
  placeholder?: string;
  /** The connector's own default — a boolean equal to it is not sent. */
  default?: boolean;
  /** select only */
  options?: string[];
  min?: number;
  /** Show only while this holds (values are the live form values). */
  when?: (values: FormValues, ctx: FormContext) => boolean;
  /** Not a config key: consumed by `finalize` (e.g. a header name). */
  virtual?: boolean;
  /** Rendered by the connector's own component, not the generic field list (still validated). */
  hidden?: boolean;
  /** A path the folder picker can fill (with `include` from ticked subfolders). */
  browse?: boolean;
}

/** What the single credential is called when it is not a plain token (`form.credential.<label>` / `<label>Hint`). */
export type CredentialLabel = 'webhookUrl' | 'longLivedToken' | 'password' | 'botToken';

/**
 * What a connected-account connector also takes instead of an account:
 * a vendor token (Pipedrive, HubSpot), a JWT bearer JSON (Salesforce),
 * an inbound webhook URL (Bitrix24), a long-lived token (Kommo), a bot
 * token of an app already installed in the workspace (Slack).
 */
export type OAuthAlternative = 'token' | 'jwtBearer' | 'webhookUrl' | 'longLivedToken' | 'botToken';

export type CredentialSpec =
  | {
      kind: 'single';
      required: (values: FormValues) => boolean;
      shown: (values: FormValues) => boolean;
      label?: CredentialLabel;
    }
  | { kind: 'pair'; required: false; shown: (values: FormValues) => boolean }
  /** A connected account (the catalogue entry's `oauth` names the provider); required on the brain host, unless the alternative is pasted. */
  | { kind: 'oauth'; alternative?: OAuthAlternative };

/** What the operator typed or picked for the credential. */
export interface SecretValues {
  single: string;
  keyId: string;
  keySecret: string;
  /** The connected account chosen (`source_oauth_grant:…`). */
  grantId: string;
}

export const EMPTY_SECRET: SecretValues = { single: '', keyId: '', keySecret: '', grantId: '' };

export interface ConnectorForm {
  fields: FieldSpec[];
  credential: CredentialSpec | null;
  /** Post-assembly hook for keys that are not a 1:1 field (auth scheme). */
  finalize?: (config: Record<string, unknown>, values: FormValues) => Record<string, unknown>;
}

export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export interface FormContext {
  host: 'server' | 'agent';
  entry: SourceCatalogEntry;
  fsRoots: string[];
  egressAllowPrivate: boolean;
  /** The agent the connection will run on (its check-in names what it offers). */
  agentId?: string;
}

const authHeader: FieldSpec = {
  key: 'authHeader',
  type: 'text',
  mono: true,
  placeholder: 'X-Api-Key',
  virtual: true,
  when: (v) => v['authScheme'] === 'header',
};

const allowPrivate: FieldSpec = {
  key: 'allowPrivate',
  type: 'boolean',
  default: false,
  advanced: true,
  when: (_v, ctx) => ctx.egressAllowPrivate,
};

const FS: ConnectorForm = {
  fields: [
    {
      key: 'root',
      type: 'path',
      required: true,
      mono: true,
      placeholder: '/srv/docs',
      browse: true,
    },
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
};

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
};

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
};

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
};

const CLOUD_LIMITS: FieldSpec[] = [
  { key: 'extensions', type: 'list', mono: true, placeholder: 'md, txt, csv, json, html' },
  { key: 'maxFiles', type: 'number', min: 1, advanced: true },
  { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
];

const GDRIVE: ConnectorForm = {
  fields: [
    { key: 'folderId', type: 'text', mono: true, placeholder: 'root' },
    { key: 'includeShared', type: 'boolean', default: false },
    {
      key: 'driveId',
      type: 'text',
      mono: true,
      advanced: true,
      placeholder: '0AAbCdEfGhIjKlMnOpQ',
    },
    ...CLOUD_LIMITS,
  ],
  credential: { kind: 'oauth' },
};

const ONEDRIVE: ConnectorForm = {
  fields: [
    { key: 'folderPath', type: 'text', mono: true, placeholder: '/Documents/Team' },
    {
      key: 'siteId',
      type: 'text',
      mono: true,
      advanced: true,
      placeholder: 'contoso.sharepoint.com,guid,guid',
    },
    { key: 'driveId', type: 'text', mono: true, advanced: true },
    ...CLOUD_LIMITS,
  ],
  credential: { kind: 'oauth' },
};

const PIPEDRIVE: ConnectorForm = {
  fields: [
    {
      key: 'apiDomain',
      type: 'url',
      mono: true,
      advanced: true,
      placeholder: 'https://acme.pipedrive.com',
    },
  ],
  credential: { kind: 'oauth', alternative: 'token' },
};

const DROPBOX: ConnectorForm = {
  fields: [{ key: 'path', type: 'text', mono: true, placeholder: '/Documents' }, ...CLOUD_LIMITS],
  credential: { kind: 'oauth' },
};

const HUBSPOT: ConnectorForm = { fields: [], credential: { kind: 'oauth', alternative: 'token' } };

/** Notion (W4.5): everything the integration can see, or the subtrees under the named pages; a connected workspace. */
const NOTION: ConnectorForm = {
  fields: [
    { key: 'rootPageIds', type: 'list', mono: true, placeholder: '1a2b3c4d-…' },
    { key: 'maxPages', type: 'number', min: 1, advanced: true },
    { key: 'maxBlocks', type: 'number', min: 1, advanced: true },
  ],
  credential: { kind: 'oauth' },
};

/** Confluence Cloud (W4.5): the site (when the account reaches several), the spaces, blog posts; a connected Atlassian account. */
const CONFLUENCE: ConnectorForm = {
  fields: [
    { key: 'spaceKeys', type: 'list', mono: true, placeholder: 'ENG\nOPS' },
    { key: 'site', type: 'text', mono: true, placeholder: 'acme.atlassian.net' },
    { key: 'includeBlogposts', type: 'boolean', default: false },
    { key: 'maxPages', type: 'number', min: 1, advanced: true },
  ],
  credential: { kind: 'oauth' },
};

/**
 * Salesforce: a connected account (the org comes from the grant) or a
 * JWT bearer for an integration user; the org, the login host, the API
 * version and the bulk first walk are advanced.
 */
const SALESFORCE: ConnectorForm = {
  fields: [
    {
      key: 'instanceUrl',
      type: 'url',
      mono: true,
      advanced: true,
      placeholder: 'https://acme.my.salesforce.com',
    },
    {
      key: 'loginUrl',
      type: 'url',
      mono: true,
      advanced: true,
      placeholder: 'https://login.salesforce.com',
    },
    { key: 'apiVersion', type: 'text', mono: true, advanced: true, placeholder: 'v62.0' },
    { key: 'bulk', type: 'boolean', default: false, advanced: true },
  ],
  credential: { kind: 'oauth', alternative: 'jwtBearer' },
};

const authParam: FieldSpec = {
  key: 'authParam',
  type: 'text',
  mono: true,
  placeholder: 'api_key',
  virtual: true,
  when: (v) => v['authScheme'] === 'query',
};

/**
 * Any JSON list API as config: the base URL and how the credential
 * rides; the endpoints themselves come from the assistant's proposal
 * (RestApiDescribe) and travel in the records choice, not in a field.
 */
const REST_RECORDS: ConnectorForm = {
  fields: [
    {
      key: 'baseUrl',
      type: 'url',
      required: true,
      mono: true,
      placeholder: 'https://crm.example.com/api',
    },
    {
      key: 'authScheme',
      type: 'select',
      options: ['bearer', 'header', 'query', 'basic', 'none'],
      virtual: true,
    },
    authHeader,
    authParam,
    allowPrivate,
  ],
  credential: {
    kind: 'single',
    required: (v) => v['authScheme'] !== 'none',
    shown: (v) => v['authScheme'] !== 'none',
  },
  finalize: (config, values) => {
    const out = withAuthScheme(config, values);
    if (values['authScheme'] === 'none') out['authScheme'] = 'none';
    return out;
  },
};

/** A connected account (the portal comes from the grant) or the inbound webhook URL itself (its code is the secret); a self-hosted portal may sit on the LAN. */
const BITRIX24: ConnectorForm = {
  fields: [allowPrivate],
  credential: { kind: 'oauth', alternative: 'webhookUrl' },
};

/** A connected account (the host comes from the grant) or a long-lived token, which needs the account's URL. */
const KOMMO: ConnectorForm = {
  fields: [
    {
      key: 'baseUrl',
      type: 'url',
      requiredWithoutGrant: true,
      mono: true,
      placeholder: 'https://acme.kommo.com',
    },
    allowPrivate,
  ],
  credential: { kind: 'oauth', alternative: 'longLivedToken' },
};

/**
 * A database read by the local agent (W4.4): the database by the name
 * the agent holds a DSN for, the tables / views as record types
 * (`entities`, kept as JSON in a hidden field and edited by
 * DbEntitiesFields), no credential — the DSN never reaches the brain.
 */
const DB: ConnectorForm = {
  fields: [
    { key: 'database', type: 'text', required: true, mono: true, hidden: true, placeholder: 'crm' },
    { key: 'entities', type: 'text', virtual: true, hidden: true },
    { key: 'pageSize', type: 'number', min: 1, advanced: true },
    { key: 'maxRows', type: 'number', min: 1, advanced: true },
  ],
  credential: null,
  finalize: (config, values) => ({
    ...config,
    entities: parseDbEntities(String(values['entities'] ?? '')),
  }),
};

export interface DbEntityDraft {
  type: string;
  table: string;
  idColumn: string;
  nameColumn: string;
  updatedAtColumn: string;
  /** Comma-separated as typed. */
  columns: string;
  /** One per line: `kind = column -> targetType`. */
  relations: string;
}

export const EMPTY_DB_ENTITY: DbEntityDraft = {
  type: '',
  table: '',
  idColumn: '',
  nameColumn: '',
  updatedAtColumn: '',
  columns: '',
  relations: '',
};

const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const RELATION_LINE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|→)\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/** The drafts as typed (the hidden `entities` value), or the empty list. */
export function dbDraftsOf(raw: string): DbEntityDraft[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((d) => ({ ...EMPTY_DB_ENTITY, ...(d as Partial<DbEntityDraft>) }));
  } catch {
    return [];
  }
}

/** Why the drafts cannot be sent: the first problem, in the form's error vocabulary; null = fine. */
export function dbEntitiesError(raw: string): FieldError | null {
  const drafts = dbDraftsOf(raw);
  if (drafts.length === 0) return 'required';
  for (const d of drafts) {
    if (!SQL_IDENT.test(d.type.trim()) || !SQL_TABLE.test(d.table.trim())) return 'identifier';
    for (const col of [d.idColumn, d.nameColumn, d.updatedAtColumn, ...splitList(d.columns)]) {
      if (col.trim() && !SQL_IDENT.test(col.trim())) return 'identifier';
    }
    for (const line of d.relations
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (!RELATION_LINE.test(line)) return 'identifier';
    }
  }
  return null;
}

/** The drafts as the brain's `config.entities` — blanks left out, lists split. */
export function parseDbEntities(raw: string): Array<Record<string, unknown>> {
  return dbDraftsOf(raw).map((d) => {
    const columns = splitList(d.columns);
    const relations = d.relations
      .split('\n')
      .map((l) => RELATION_LINE.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ kind: m[1]!, column: m[2]!, targetType: m[3]! }));
    return {
      type: d.type.trim(),
      table: d.table.trim(),
      ...(d.idColumn.trim() ? { idColumn: d.idColumn.trim() } : {}),
      ...(d.nameColumn.trim() ? { nameColumn: d.nameColumn.trim() } : {}),
      ...(d.updatedAtColumn.trim() ? { updatedAtColumn: d.updatedAtColumn.trim() } : {}),
      ...(columns.length > 0 ? { columns } : {}),
      ...(relations.length > 0 ? { relations } : {}),
    };
  });
}

/** The drafts as the mapping table lists them: one entity per draft, its listed columns as the fields a fact can come from. */
export function dbProposalOf(raw: string): Array<{
  type: string;
  label: string;
  source: 'operator';
  confidence: number;
  reason: string;
  fields: Array<{ key: string; label: string }>;
}> {
  return dbDraftsOf(raw)
    .filter((d) => d.type.trim())
    .map((d) => ({
      type: d.type.trim(),
      label: d.type.trim(),
      source: 'operator' as const,
      confidence: 1,
      reason: d.table.trim(),
      fields: splitList(d.columns).map((c) => ({ key: c, label: c })),
    }));
}

/** An MCP server that signs in (`auth: 'oauth'`, W4.3): the same fields, the credential is the grant at that server. */
const MCP_HTTP_OAUTH: ConnectorForm = {
  fields: MCP_HTTP.fields.filter((f) => f.key !== 'authScheme' && f.key !== 'authHeader'),
  credential: { kind: 'oauth' },
};

const MCP_STDIO: ConnectorForm = { fields: [], credential: null };

const GIT: ConnectorForm = {
  fields: [
    { key: 'repo', type: 'path', required: true, mono: true, placeholder: '/home/me/repo' },
    { key: 'ref', type: 'text', mono: true, placeholder: 'HEAD' },
    { key: 'include', type: 'list', mono: true, placeholder: 'docs/**\nREADME.md' },
    {
      key: 'extensions',
      type: 'list',
      mono: true,
      advanced: true,
      placeholder: 'md, txt, rst, adoc',
    },
    { key: 'maxFiles', type: 'number', min: 1, advanced: true },
    { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
  ],
  credential: null,
};

const EXTERNAL: ConnectorForm = { fields: [], credential: null };

/** `authScheme: none | bearer | basic | header` + `authHeader` → the connector's `authScheme`. */
function withAuthScheme(
  config: Record<string, unknown>,
  values: FormValues,
): Record<string, unknown> {
  const scheme = values['authScheme'];
  const out = { ...config };
  delete out['authScheme'];
  delete out['authHeader'];
  delete out['authParam'];
  if (scheme === 'basic') out['authScheme'] = 'basic';
  if (scheme === 'header') {
    const name = String(values['authHeader'] ?? '').trim();
    if (name) out['authScheme'] = `header:${name}`;
  }
  if (scheme === 'query') {
    const name = String(values['authParam'] ?? '').trim();
    if (name) out['authScheme'] = `query:${name}`;
  }
  return out;
}

/** The form for an entry, or null when this build knows no form for its connector (JSON editor). */
/** Gmail (W4.6): the mailbox's own query, labels, a start date; the attachments entry shares the form (its file gate under Advanced); a connected Google account. */
const GMAIL: ConnectorForm = {
  fields: [
    { key: 'query', type: 'text', mono: true, placeholder: 'label:clients -category:promotions' },
    { key: 'labelIds', type: 'list', mono: true, placeholder: 'INBOX\nSENT' },
    { key: 'since', type: 'text', mono: true, placeholder: '2026-01-01' },
    { key: 'maxMessages', type: 'number', min: 1, advanced: true, placeholder: '2000' },
    { key: 'includeSpamTrash', type: 'boolean', default: false, advanced: true },
    { key: 'extensions', type: 'list', mono: true, advanced: true, placeholder: 'pdf, docx, xlsx' },
    { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
  ],
  credential: { kind: 'oauth' },
};

/** IMAP (W4.6): host, port, TLS, user, the mailboxes, a start date; the password is the credential. */
const IMAP: ConnectorForm = {
  fields: [
    { key: 'host', type: 'text', required: true, mono: true, placeholder: 'imap.example.com' },
    { key: 'port', type: 'number', min: 1, mono: true, placeholder: '993' },
    { key: 'tls', type: 'boolean', default: true },
    { key: 'user', type: 'text', required: true, mono: true, placeholder: 'me@example.com' },
    { key: 'mailboxes', type: 'list', mono: true, placeholder: 'INBOX\nClients' },
    { key: 'since', type: 'text', mono: true, placeholder: '2026-01-01' },
    { key: 'maxMessages', type: 'number', min: 1, advanced: true, placeholder: '2000' },
    allowPrivate,
  ],
  credential: { kind: 'single', required: () => true, shown: () => true, label: 'password' },
};

/** Slack (W4.7): the channels to read, a start date; a connected workspace or a bot token. */
const SLACK: ConnectorForm = {
  fields: [
    { key: 'channels', type: 'list', mono: true, placeholder: 'general\nsales' },
    { key: 'since', type: 'text', mono: true, placeholder: '2026-01-01' },
    { key: 'includeThreads', type: 'boolean', default: true },
    { key: 'maxMessages', type: 'number', min: 1, advanced: true, placeholder: '2000' },
  ],
  credential: { kind: 'oauth', alternative: 'botToken' },
};

/** Telegram (W4.7): the chats to keep; the bot token is the credential. */
const TELEGRAM: ConnectorForm = {
  fields: [
    { key: 'chats', type: 'list', mono: true, placeholder: '@acme_team\n-1001234567890' },
    { key: 'maxMessages', type: 'number', min: 1, advanced: true, placeholder: '2000' },
  ],
  credential: { kind: 'single', required: () => true, shown: () => true, label: 'botToken' },
};

/** GitHub (W4.8): one repository over the API — the same form for its issues and its docs. */
const GITHUB: ConnectorForm = {
  fields: [
    { key: 'repo', type: 'text', required: true, mono: true, placeholder: 'acme/handbook' },
    { key: 'since', type: 'text', mono: true, placeholder: '2026-01-01' },
    { key: 'includePullRequests', type: 'boolean', default: true },
    { key: 'labels', type: 'list', mono: true, placeholder: 'bug\nneeds-decision' },
    { key: 'paths', type: 'list', mono: true, placeholder: 'docs/\nadr/' },
    { key: 'ref', type: 'text', mono: true, advanced: true, placeholder: 'main' },
    {
      key: 'baseUrl',
      type: 'url',
      mono: true,
      advanced: true,
      placeholder: 'https://ghe.acme.test/api/v3',
    },
    { key: 'extensions', type: 'list', mono: true, advanced: true },
    { key: 'maxItems', type: 'number', min: 1, advanced: true },
    { key: 'maxFiles', type: 'number', min: 1, advanced: true },
    { key: 'maxFileBytes', type: 'number', min: 1, advanced: true },
    allowPrivate,
  ],
  credential: { kind: 'oauth', alternative: 'token' },
};

export function formFor(entry: SourceCatalogEntry): ConnectorForm | null {
  if (entry.kind === 'external') return EXTERNAL;
  if (entry.kind === 'mcp') {
    if (entry.mcp?.transport === 'stdio') return MCP_STDIO;
    return entry.mcp?.auth === 'oauth' ? MCP_HTTP_OAUTH : MCP_HTTP;
  }
  switch (entry.connector) {
    case 'fs':
      return FS;
    case 'url':
      return URL_FORM;
    case 's3':
      return S3;
    case 'git':
      return GIT;
    case 'gdrive':
      return GDRIVE;
    case 'onedrive':
      return ONEDRIVE;
    case 'dropbox':
      return DROPBOX;
    case 'pipedrive':
      return PIPEDRIVE;
    case 'hubspot':
      return HUBSPOT;
    case 'notion':
      return NOTION;
    case 'confluence':
      return CONFLUENCE;
    case 'gmail':
      return GMAIL;
    case 'imap':
      return IMAP;
    case 'github':
      return GITHUB;
    case 'slack':
      return SLACK;
    case 'telegram':
      return TELEGRAM;
    case 'salesforce':
      return SALESFORCE;
    case 'bitrix24':
      return BITRIX24;
    case 'kommo':
      return KOMMO;
    case 'rest_records':
      return REST_RECORDS;
    case 'db':
      return DB;
    default:
      return null;
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
    if (f.hidden) return false;
    if (f.advanced && !advanced) return false;
    return f.when ? f.when(values, ctx) : true;
  });
}

/**
 * Initial values: booleans at the connector's default, selects at their
 * first option, everything else empty — the connector's example is a
 * placeholder, never a value the operator has to notice and delete.
 */
export function initialValues(form: ConnectorForm, _entry: SourceCatalogEntry): FormValues {
  const out: FormValues = {};
  for (const f of form.fields) {
    if (f.type === 'boolean') out[f.key] = f.default ?? false;
    else if (f.type === 'select') out[f.key] = f.options?.[0] ?? '';
    else out[f.key] = '';
  }
  return out;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The connection `config` the brain receives: present, non-empty values only. */
export function configFrom(
  form: ConnectorForm,
  values: FormValues,
  ctx: FormContext,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of form.fields) {
    if (f.when && !f.when(values, ctx)) continue;
    const v = values[f.key];
    if (f.type === 'boolean') {
      if (typeof v === 'boolean' && v !== (f.default ?? false)) config[f.key] = v;
      continue;
    }
    const raw = typeof v === 'string' ? v.trim() : '';
    if (raw.length === 0) continue;
    if (f.type === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) config[f.key] = n;
    } else if (f.type === 'list') {
      const list = splitList(raw);
      if (list.length > 0) config[f.key] = list;
    } else if (f.type === 'select') {
      config[f.key] = raw;
    } else {
      config[f.key] = raw;
    }
  }
  return form.finalize ? form.finalize(config, values) : config;
}

/** The credential string the brain stores: a bearer / token, `accessKeyId:secretAccessKey`, or `oauth:<grant id>`. */
export function credentialFrom(form: ConnectorForm, secret: SecretValues): string | undefined {
  if (!form.credential) return undefined;
  if (form.credential.kind === 'oauth') {
    // A connected account, else the alternative pasted in (Pipedrive's API token, a Salesforce JWT bearer JSON).
    return secret.grantId ? `oauth:${secret.grantId}` : secret.single.trim() || undefined;
  }
  if (form.credential.kind === 'pair') {
    const id = secret.keyId.trim();
    const key = secret.keySecret.trim();
    if (!id && !key) return undefined;
    return `${id}:${key}`;
  }
  return secret.single.length > 0 ? secret.single : undefined;
}

export type FieldError =
  | 'required'
  | 'path'
  | 'url'
  | 'number'
  | 'credential'
  | 'header'
  | 'jail'
  | 'account'
  | 'jwtBearer'
  | 'identifier';

/** Field-level errors, keyed by field (or `credential`); empty = the step may proceed. */
export function validate(
  form: ConnectorForm,
  values: FormValues,
  ctx: FormContext,
  secret: SecretValues,
): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const f of form.fields) {
    if (f.when && !f.when(values, ctx)) continue;
    const v = values[f.key];
    const raw = typeof v === 'string' ? v.trim() : '';
    if ((f.required || (f.requiredWithoutGrant && !secret.grantId)) && raw.length === 0) {
      errors[f.key] = 'required';
      continue;
    }
    if (raw.length === 0) continue;
    if (f.type === 'path' && !raw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(raw))
      errors[f.key] = 'path';
    if (f.type === 'path' && f.key === 'root' && ctx.host === 'server' && ctx.fsRoots.length > 0) {
      const inside = ctx.fsRoots.some(
        (r) => raw === r || raw.startsWith(r.endsWith('/') ? r : `${r}/`),
      );
      if (!inside) errors[f.key] = 'jail';
    }
    if (f.type === 'url' && !isHttpUrl(raw)) errors[f.key] = 'url';
    if (f.type === 'list' && (f.key === 'urls' || f.key === 'sitemaps')) {
      if (splitList(raw).some((u) => !isHttpUrl(u))) errors[f.key] = 'url';
    }
    if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || (f.min !== undefined && n < f.min)) errors[f.key] = 'number';
    }
  }
  if (form.fields.some((f) => f.key === 'entities' && f.hidden)) {
    const problem = dbEntitiesError(String(values['entities'] ?? ''));
    if (problem) errors['entities'] = problem;
  }
  if (form.fields.some((f) => f.key === 'urls') && form.fields.some((f) => f.key === 'sitemaps')) {
    const urls = String(values['urls'] ?? '').trim();
    const sitemaps = String(values['sitemaps'] ?? '').trim();
    if (!urls && !sitemaps) errors['urls'] = 'required';
  }
  if (values['authScheme'] === 'header' && !String(values['authHeader'] ?? '').trim()) {
    errors['authHeader'] = 'header';
  }
  if (values['authScheme'] === 'query' && !String(values['authParam'] ?? '').trim()) {
    errors['authParam'] = 'header';
  }
  if (form.credential?.kind === 'single' && form.credential.required(values) && !secret.single) {
    errors['credential'] = 'credential';
  }
  if (form.credential?.kind === 'pair') {
    const id = secret.keyId.trim();
    const key = secret.keySecret.trim();
    if ((id && !key) || (!id && key)) errors['credential'] = 'credential';
  }
  // The brain runs the cloud connector, so it needs the account; an
  // agent-host connection would carry its own (none of these run there).
  if (
    form.credential?.kind === 'oauth' &&
    ctx.host === 'server' &&
    !secret.grantId &&
    !secret.single.trim()
  ) {
    errors['credential'] = 'account';
  }
  if (
    form.credential?.kind === 'oauth' &&
    form.credential.alternative === 'jwtBearer' &&
    !secret.grantId &&
    secret.single.trim()
  ) {
    if (!isJwtBearer(secret.single)) errors['credential'] = 'jwtBearer';
  }
  return errors;
}

/** `{ clientId, username, privateKey }` with a PEM key — what the Salesforce connector parses. */
export function isJwtBearer(raw: string): boolean {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return (
      typeof v.clientId === 'string' &&
      v.clientId.trim().length > 0 &&
      typeof v.username === 'string' &&
      v.username.trim().length > 0 &&
      typeof v.privateKey === 'string' &&
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v.privateKey)
    );
  } catch {
    return false;
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
