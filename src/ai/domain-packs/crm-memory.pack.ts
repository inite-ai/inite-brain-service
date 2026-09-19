import type { DomainPackManifest } from './manifest';

const single = {
  datatype: 'string' as const,
  semantics: 'single_active' as const,
  decayHalfLifeDays: null,
  piiClass: 'none' as const,
  status: 'active' as const,
};

/**
 * crm_memory — the records pack (docs/roadmap/crm-sources-2026-09.md).
 * A CRM is a table of records with a revision, not a document store: a
 * deal's stage, amount and owner, a contact's title and company, are
 * FACTS the system of record already holds, so they enter as
 * deterministic candidates through the records door — never as prose a
 * model re-extracts. `indexer.mode: 'external'` is what makes that so:
 * the render of a record is filed for grounding and search, and nothing
 * in-process reads it with a model.
 *
 * The vocabulary is what any CRM knows about people, organizations and
 * deals; every vendor's fields map onto it (a connector ships the
 * preset, the operator adjusts it). All of it is the DERIVABLE class —
 * pointers at the CRM's current state, bound to the revision they were
 * read at (`source_version_match`), so a stale value is marked on drift
 * and a deleted record closes its facts. Identity is the record's own id
 * (a renamed contact stays one entity; two "John Smith"s stay two).
 *
 * The one state model, `deal_stage`, names a CANONICAL funnel; a
 * connection maps its pipeline's stages onto it (the vendor label is
 * always kept as the plain `deal_stage` fact). Sources: `push` — any
 * automation posts record envelopes to the connection's records
 * endpoint — the vendor connectors on the records contract
 * (`pipedrive`, `hubspot`, `bitrix24`, `kommo`) and `custom`, the
 * config-driven `rest_records` connector for the long tail.
 */
export const CRM_MEMORY_PACK: DomainPackManifest = {
  id: 'crm_memory',
  version: '0.5.0',
  description:
    'What a CRM knows — people, organizations and deals as facts with the revision they were read at: title, company, owner, stage, amount, dates, source. Records enter deterministically through the records door (no model call); prose fields (notes) go to the ordinary extractor.',
  indexer: {
    mode: 'external',
    relevance: { verticals: ['crm', 'sales'] },
  },
  sources: [
    {
      id: 'push',
      kind: 'external',
      shape: 'structure',
      title: 'Pushed records (webhook / automation)',
      description:
        'Record envelopes posted by a CRM outbound webhook or an automation (Make, n8n, Zapier, Albato, a script) to POST /v1/source-connections/<id>/records with a brain:write key — batches of { entityType, externalId, name, attributes, relations?, updatedAt? } plus the ids that are gone. No polling, no credential on the brain. config: { mapping? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: 'manual' },
    },
    {
      id: 'pipedrive',
      kind: 'native',
      connector: 'pipedrive',
      shape: 'structure',
      title: 'Pipedrive',
      description:
        'Deals, persons and organizations of a Pipedrive account, incrementally through updated_since + cursor (API v2), as a connected account or with an API token. config: { entities?, mapping?, apiDomain? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'hubspot',
      kind: 'native',
      connector: 'hubspot',
      shape: 'structure',
      title: 'HubSpot',
      description:
        'Deals, contacts and companies of a HubSpot portal, incrementally through the CRM Search API (last-modified windows + cursor; associations read per page), as a connected account or with a private-app access token. config: { entities?, mapping? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'bitrix24',
      kind: 'native',
      connector: 'bitrix24',
      shape: 'structure',
      title: 'Bitrix24',
      description:
        'Deals, leads, contacts and companies of a Bitrix24 portal through crm.item.list (filter[>updatedTime] + start), stages / sources / pipelines resolved to names, as a connected account (a local / Marketplace application) or with an inbound webhook URL as the credential. config: { entities?, mapping?, allowPrivate? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'db',
      kind: 'native',
      connector: 'db',
      shape: 'structure',
      title: 'Database (agent)',
      description:
        'A self-hosted CRM, ERP or ticketing backend read from its database by the local agent (host agent:<id>): each table or view one record type, each row one record, foreign keys as relations; incremental by a change column, else a full walk. The agent holds the DSN (brain-agent db add <name> <dsn>); the brain knows the name only. Postgres, MySQL, SQLite, read-only. config: { database, entities: [{ type, table, idColumn?, nameColumn?, updatedAtColumn?, columns?, relations? }], mapping? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'kommo',
      kind: 'native',
      connector: 'kommo',
      shape: 'structure',
      title: 'Kommo / amoCRM',
      description:
        'Leads (deals), contacts and companies of a Kommo or amoCRM account through API v4 (filter[updated_at][from] + page), statuses / pipelines / users resolved to names, as a connected account or with a long-lived token of a private integration and the account URL. config: { baseUrl?, entities?, mapping? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'salesforce',
      kind: 'native',
      connector: 'salesforce',
      shape: 'structure',
      title: 'Salesforce',
      description:
        "Opportunities, contacts, accounts (and leads, cases) of a Salesforce org through SOQL over REST (LastModifiedDate > since, nextRecordsUrl; the deleted-ids feed closes deletions), Bulk API 2.0 for a large org's first walk, as a connected account or as an integration user (JWT bearer). config: { entities?, mapping?, instanceUrl?, loginUrl?, apiVersion?, bulk? }.",
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'custom',
      kind: 'native',
      connector: 'rest_records',
      shape: 'structure',
      title: 'Custom REST / OpenAPI',
      description:
        'Any CRM, ERP or ticketing backend with a JSON list API and no connector of its own: its endpoints described as config (list path, where the rows sit, paging style, updated-since parameter, id / name / updated-at fields, relations) — proposed by the mapping assistant from an OpenAPI document or a sample answer, verified by the preview. config: { baseUrl, authScheme?, endpoints, entities?, mapping? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
  ],
  predicates: [
    {
      localId: 'job_title',
      displayLabel: 'job title',
      description: `TYPE   subject is a person; value is their role at their organization
ADMIT  a CRM record or text names the person's title ("Head of Procurement")
VALUE  the title verbatim`,
      ...single,
    },
    {
      localId: 'owner',
      displayLabel: 'owned by',
      description: `TYPE   subject is a person, organization or deal; value is the CRM user responsible for it
ADMIT  the record names its owner / responsible user
VALUE  the owner's name verbatim`,
      ...single,
    },
    {
      localId: 'lead_source',
      displayLabel: 'lead source',
      description: `TYPE   subject is a person or deal; value is where it came from
ADMIT  the record names a source / channel ("Inbound web form", "Referral")
VALUE  the source verbatim`,
      ...single,
    },
    {
      localId: 'lifecycle_stage',
      displayLabel: 'lifecycle stage',
      description: `TYPE   subject is a person or organization; value is its lifecycle stage in the CRM
ADMIT  the record carries a lifecycle / status field ("lead", "customer", "churned")
VALUE  the stage verbatim`,
      ...single,
    },
    {
      localId: 'industry',
      displayLabel: 'industry',
      description: `TYPE   subject is an organization; value is its industry
ADMIT  the record names the organization's industry / sector
VALUE  the industry verbatim`,
      ...single,
    },
    {
      localId: 'website',
      displayLabel: 'website',
      description: `TYPE   subject is an organization; value is its website
ADMIT  the record carries a website / domain
VALUE  the URL or domain verbatim`,
      ...single,
    },
    {
      localId: 'deal_stage',
      displayLabel: 'deal stage',
      description: `TYPE   subject is a deal; value is the pipeline stage it is in
ADMIT  the record names the deal's current stage ("Negotiation", "Proposal sent")
VALUE  the stage label verbatim — the CRM's own name for it`,
      ...single,
    },
    {
      localId: 'deal_status',
      displayLabel: 'deal status',
      description: `TYPE   subject is a deal; value is open / won / lost (or the CRM's equivalent)
ADMIT  the record carries a status field
VALUE  the status verbatim`,
      ...single,
    },
    {
      localId: 'deal_amount',
      displayLabel: 'deal amount',
      description: `TYPE   subject is a deal; value is its monetary value
ADMIT  the record carries a value / amount
VALUE  the amount as the CRM states it ("40000")`,
      ...single,
    },
    {
      localId: 'currency',
      displayLabel: 'currency',
      description: `TYPE   subject is a deal; value is the currency of its amount
ADMIT  the record names a currency code
VALUE  the code verbatim ("EUR")`,
      ...single,
    },
    {
      localId: 'pipeline',
      displayLabel: 'pipeline',
      description: `TYPE   subject is a deal; value is the pipeline it belongs to
ADMIT  the record names its pipeline
VALUE  the pipeline name verbatim`,
      ...single,
    },
    {
      localId: 'probability',
      displayLabel: 'win probability',
      description: `TYPE   subject is a deal; value is the CRM's win probability
ADMIT  the record carries a probability
VALUE  the number as stated ("60")`,
      ...single,
    },
    {
      localId: 'expected_close',
      displayLabel: 'expected close',
      description: `TYPE   subject is a deal; value is the expected close date
ADMIT  the record carries an expected / planned close date
VALUE  the date as stated`,
      ...single,
      datatype: 'date',
    },
    {
      localId: 'won_at',
      displayLabel: 'won at',
      description: `TYPE   subject is a deal; value is when it was won
ADMIT  the record carries a won time
VALUE  the timestamp as stated`,
      ...single,
      datatype: 'datetime',
    },
    {
      localId: 'lost_at',
      displayLabel: 'lost at',
      description: `TYPE   subject is a deal; value is when it was lost
ADMIT  the record carries a lost time
VALUE  the timestamp as stated`,
      ...single,
      datatype: 'datetime',
    },
    {
      localId: 'lost_reason',
      displayLabel: 'lost reason',
      description: `TYPE   subject is a deal; value is why it was lost
ADMIT  the record carries a lost reason
VALUE  the reason verbatim`,
      ...single,
    },
    {
      localId: 'next_step',
      displayLabel: 'next step',
      description: `TYPE   subject is a deal; value is the agreed next activity
ADMIT  the record or text names the next step ("send revised proposal by Friday")
VALUE  the step verbatim`,
      ...single,
    },
    {
      localId: 'last_activity_at',
      displayLabel: 'last activity',
      description: `TYPE   subject is a person, organization or deal; value is when it was last touched
ADMIT  the record carries a last-activity time
VALUE  the timestamp as stated`,
      ...single,
      datatype: 'datetime',
    },
    {
      localId: 'label',
      displayLabel: 'label',
      description: `TYPE   subject is any record; value is a tag / label the CRM applies
ADMIT  the record carries labels or tags
VALUE  one label per fact (multi-valued)`,
      ...single,
      semantics: 'append_only',
    },
  ],
  extractionProfile: {
    guidance: `CRM inputs are RECORDS (contacts, organizations, deals) — their structured
fields arrive as facts by themselves; this profile is for the PROSE they
carry: notes, call summaries, next steps. Treat the record's subject (the
person, organization or deal named in the title) as the SUBJECT entity.
Prefer crm_memory__next_step for agreed actions, crm_memory__lost_reason
for why a deal was lost, crm_memory__deal_stage only when a stage is named
verbatim. Copy values VERBATIM — "send revised proposal by Friday", not a
paraphrase.`,
    fewShot: [
      {
        text: 'Call with Acme Robotics: they asked for a revised proposal by Friday; budget owner is Grace Hopper.',
        note: "deal/organization 'Acme Robotics' → crm_memory__next_step='revised proposal by Friday'; person 'Grace Hopper' → crm_memory__owner is NOT this (owner = the CRM user), but a relation to Acme.",
      },
      {
        text: 'Lost to a cheaper competitor after the pilot; the deal moved to Lost.',
        note: "→ crm_memory__lost_reason='cheaper competitor after the pilot', crm_memory__deal_stage='Lost'.",
      },
    ],
  },
  memoryModel: {
    sceneSchemas: [
      {
        id: 'record_update',
        description:
          'A CRM record changed state: a deal moved to another stage, was won or lost; a contact changed lifecycle stage.',
        cues: ['moved to', 'stage', 'won', 'lost', 'qualified'],
      },
    ],
    stateModels: [
      {
        id: 'deal_stage',
        subjectType: 'deal',
        states: ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'on_hold'],
        transitions: [
          { from: 'new', to: 'qualified' },
          { from: 'qualified', to: 'proposal' },
          { from: 'proposal', to: 'negotiation' },
          { from: 'negotiation', to: 'won' },
          { from: 'negotiation', to: 'lost' },
          { from: 'proposal', to: 'lost' },
          { from: 'qualified', to: 'lost' },
          { from: 'new', to: 'lost' },
          { from: 'negotiation', to: 'on_hold' },
          { from: 'on_hold', to: 'negotiation' },
          { from: 'lost', to: 'new' },
        ],
      },
    ],
    attentionHints: [
      {
        cue: 'deal',
        prefer: ['deal_stage', 'deal_amount', 'next_step'],
        zoom: ['facts'],
        weight: 0.6,
      },
      {
        cue: 'stage',
        prefer: ['deal_stage', 'deal_status'],
        zoom: ['facts', 'episodes'],
        weight: 0.6,
      },
      { cue: 'who owns', prefer: ['owner'], zoom: ['facts'], weight: 0.6 },
      { cue: 'why lost', prefer: ['lost_reason'], zoom: ['facts'], weight: 0.7 },
    ],
    // Every predicate here POINTS AT the CRM's current state: bound to the
    // revision it was read at, marked on drift, closed when the record goes.
    verificationRules: [
      {
        requires: 'source_version_match',
        appliesTo: [
          'job_title',
          'owner',
          'lead_source',
          'lifecycle_stage',
          'industry',
          'website',
          'deal_stage',
          'deal_status',
          'deal_amount',
          'currency',
          'pipeline',
          'probability',
          'expected_close',
          'won_at',
          'lost_at',
          'lost_reason',
          'next_step',
          'last_activity_at',
          'label',
        ],
      },
    ],
    retentionHints: [
      { predicateOrScene: 'lost_reason', hint: 'durable' },
      { predicateOrScene: 'record_update', hint: 'durable' },
    ],
  },
  evalFixtures: [
    {
      id: 'next_step',
      description: 'an agreed next step in a call note is captured verbatim',
      text: 'Call with Acme Robotics: they asked for a revised proposal by Friday.',
      expect: { facts: [{ predicate: 'next_step', objectIncludes: 'revised proposal by Friday' }] },
    },
    {
      id: 'lost_reason',
      description: 'why a deal was lost is captured',
      text: 'Deal with Globex lost to a cheaper competitor after the pilot.',
      expect: { facts: [{ predicate: 'lost_reason', objectIncludes: 'cheaper competitor' }] },
    },
  ],
};
