import type { DomainPackManifest } from './manifest';

/**
 * Source pack: MAIL. DISTRIBUTABLE (installed per-tenant from
 * `packs/mail-memory.pack.json`, NOT in BUILTIN_PACKS). The carrier of
 * the mail source entries — a Gmail mailbox as a connected Google
 * account, any mailbox over IMAP — and of the vocabulary a mail thread
 * yields. Mail is conversation-shaped (raw-evidence-sources-2026-09.md
 * doctrine 2): every message is ONE TURN of its thread and enters
 * through the mention door → episodes, the sender as the speaker; the
 * facts below are what people SAY in mail — what they ask for, promise,
 * decide and put a date on — never derived from headers (addresses are
 * PII the core owns; the To / Cc lines are not read into memory).
 * Attachments are the evidence plane's (`gmail_attachments`).
 *
 * Bump `version` to update.
 */
export const MAIL_MEMORY_PACK: DomainPackManifest = {
  id: 'mail_memory',
  version: '0.1.0',
  description:
    'Mail as memory — what people ask for, promise, decide and put a date on in their mail, thread by thread; the source pack that connects a Gmail account or any IMAP mailbox.',
  predicates: [
    {
      localId: 'requested',
      displayLabel: 'requested',
      description: `TYPE   subject is a person (the sender); value is what they asked for in the mail
ADMIT  the message asks the reader for something concrete — a document, a
       decision, an action, an answer ("could you send the signed contract",
       "please confirm the delivery date")
VALUE  the request, short and verbatim in substance ("the signed contract")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 90,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'committed_to',
      displayLabel: 'committed to',
      description: `TYPE   subject is a person (the sender); value is what they promised to do
ADMIT  the sender commits themselves — "I will send the invoice on Monday",
       "we'll ship the first batch by the 20th"; a wish or a plan for someone
       else is NOT a commitment
VALUE  the commitment with its date when one is stated ("send the invoice on Monday")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 90,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'decided',
      displayLabel: 'decided',
      description: `TYPE   subject is a person or organisation; value is the decision they state
ADMIT  the message states a decision as made — "we go with the second option",
       "approved", "the launch moves to October"
VALUE  the decision, short ("go with the second option")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'deadline',
      displayLabel: 'deadline',
      description: `TYPE   subject is a thing with a due date — an invoice, a delivery, a contract, a task; value is the date
ADMIT  the message states when it is due ("payment due 30 September",
       "the draft by Friday") — a stated date, not an estimate of yours
VALUE  an ISO date when it can be resolved from the message's own date, else the verbatim date text`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'discussed',
      displayLabel: 'discussed',
      description: `TYPE   subject is a person (the sender); value is the matter the message is about
ADMIT  the message is clearly about a named matter — a deal, a project, an order,
       a document ("the Q4 pricing", "order #4471")
VALUE  the matter as named ("Q4 pricing")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 180,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Inputs are MAIL THREADS as turns — every turn one message, the sender as the
speaker, quoted replies and signatures already stripped. Treat each SENDER as
one entity and extract what they ASK FOR (mail_memory__requested), what they
PROMISE (mail_memory__committed_to), what they DECIDE (mail_memory__decided) and
what MATTER they write about (mail_memory__discussed); a due date stated for a
thing is mail_memory__deadline on that thing. Only what the message SAYS: never
derive who was addressed, never turn an address into a fact. Attachments are
named in brackets — a named attachment is not a request. Copy names, amounts
and dates VERBATIM.`,
    fewShot: [
      {
        text: 'Anna Ivanova: Hi Mike, could you send the signed contract by Friday? We decided to go with the two-year term. I will send the invoice on Monday. [attachment: term-sheet.pdf]',
        note: "sender 'Anna Ivanova' → mail_memory__requested='the signed contract', mail_memory__committed_to='send the invoice on Monday', mail_memory__decided='go with the two-year term', mail_memory__discussed='the contract'; thing 'the signed contract' → mail_memory__deadline='Friday' (an ISO date when the message date resolves it).",
      },
    ],
  },
  evalFixtures: [
    {
      id: 'requested',
      description: 'what a sender asks for is captured on the sender',
      text: 'Anna Ivanova: Could you send the signed contract by Friday?',
      expect: { facts: [{ predicate: 'requested', objectIncludes: 'signed contract' }] },
    },
    {
      id: 'committed_to',
      description: 'a commitment with its date is captured on the sender',
      text: 'Bob Lee: I will send the invoice on Monday.',
      expect: { facts: [{ predicate: 'committed_to', objectIncludes: 'invoice on Monday' }] },
    },
    {
      id: 'decided',
      description: 'a decision stated as made is captured',
      text: 'Anna Ivanova: We decided to go with the two-year term.',
      expect: { facts: [{ predicate: 'decided', objectIncludes: 'two-year term' }] },
    },
  ],
  memoryModel: {
    attentionHints: [
      { cue: 'please', prefer: ['requested'], zoom: ['facts'], weight: 0.5 },
      { cue: 'could you', prefer: ['requested'], zoom: ['facts'], weight: 0.5 },
      { cue: 'i will', prefer: ['committed_to'], zoom: ['facts'], weight: 0.5 },
      { cue: 'deadline', prefer: ['deadline'], zoom: ['facts'], weight: 0.6 },
      { cue: 'by friday', prefer: ['deadline', 'committed_to'], zoom: ['facts'], weight: 0.4 },
      { cue: 'decided', prefer: ['decided'], zoom: ['facts'], weight: 0.6 },
      { cue: 'agreed', prefer: ['decided'], zoom: ['facts'], weight: 0.5 },
    ],
    retentionHints: [
      { predicateOrScene: 'requested', hint: 'standard' },
      { predicateOrScene: 'committed_to', hint: 'standard' },
      { predicateOrScene: 'decided', hint: 'durable' },
      { predicateOrScene: 'deadline', hint: 'standard' },
      { predicateOrScene: 'discussed', hint: 'ephemeral' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // Attachments (`gmail_attachments`) are documents for the evidence
    // plane — contracts, invoices, term sheets; document text extraction
    // turns them into documents through the bridge. rawEvidence absent.
    modalities: ['text', 'document'],
    processors: [{ id: 'document_text', modality: 'document', produces: ['text'] }],
  },
  sources: [
    // ── Gmail (W4.6): a connected Google account, the Gmail REST API.
    {
      id: 'gmail',
      kind: 'native',
      connector: 'gmail',
      shape: 'conversation',
      title: 'Gmail (messages as threads)',
      description:
        "The messages of a connected Gmail account — the connection's own Gmail query plus `after:<since>`, newest first, capped — each one turn of its thread through the mention door: the sender as the speaker, quoted replies and signatures stripped, attachments named; deletions from the history feed. config: { query?, labelIds?, since?, maxMessages?, includeSpamTrash? }; credential: a connected Google account.",
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    {
      id: 'gmail_attachments',
      kind: 'native',
      connector: 'gmail',
      shape: 'binary',
      title: 'Gmail (attachments)',
      description:
        'The attachments of the same messages (`has:attachment` added to the query), judged by name, type and size like a folder, handed to the evidence plane. config: as `gmail` plus { extensions?, maxFileBytes? }; credential: a connected Google account.',
      defaults: { contentPolicy: 'bytes', deletePolicy: 'close', schedule: '4h' },
    },
    // ── IMAP (W4.6): any mailbox — a host, a user, an app password.
    {
      id: 'imap',
      kind: 'native',
      connector: 'imap',
      shape: 'conversation',
      title: 'Mailbox over IMAP',
      description:
        'Any mailbox over IMAP, read-only — the mailboxes named (INBOX by default), mail since a date, the newest `maxMessages` of it, then only what is above the last UID; each message one turn of the thread its References name. config: { host, port?, tls?, user, mailboxes?, since?, maxMessages?, allowPrivate? }; credential: the mailbox password (an app password where the provider issues one).',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
  ],
};
