import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: legal / contracts. A DISTRIBUTABLE pack (installed
 * per-tenant from `packs/legal.pack.json`, NOT in BUILTIN_PACKS). Captures the
 * ontology of agreements — governing law, parties, obligations, and term — with
 * an extractionProfile + eval fixtures + memoryModel (matter / agreement /
 * obligation lifecycles, attention + retention hints, recency rules for
 * termination and effective-date claims). Bump `version` to ship an update.
 */
export const LEGAL_PACK: DomainPackManifest = {
  id: 'legal',
  version: '0.2.0',
  description:
    'Legal / contracts ontology — governing law, parties, obligations, and term of agreements, with a domain extraction profile and memory model.',
  predicates: [
    {
      localId: 'governed_by',
      displayLabel: 'governed by',
      description: `TYPE   subject is an agreement/case; value is the governing law/jurisdiction
ADMIT  text states the governing law or jurisdiction ("governed by the
       laws of England and Wales", "subject to Delaware law")
VALUE  the jurisdiction/law, verbatim ("England and Wales", "Delaware")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'party_to',
      displayLabel: 'party to',
      description: `TYPE   subject is an agreement; value is a named party
ADMIT  text names a party to the agreement ("between Acme Corp and Beta
       LLC", "the Supplier")
VALUE  one party per fact, verbatim ("Acme Corp")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'obligation',
      displayLabel: 'obligation',
      description: `TYPE   subject is a party/agreement; value is a duty/obligation
ADMIT  text states an obligation or covenant ("shall deliver within 30
       days", "must maintain insurance")
VALUE  the obligation, verbatim ("deliver within 30 days")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'effective_from',
      displayLabel: 'effective from',
      description: `TYPE   subject is an agreement; value is the effective date
ADMIT  text states when the agreement takes effect ("effective 1 January
       2026", "commences on signing")
VALUE  the effective date/term, verbatim ("1 January 2026")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'terminates_on',
      displayLabel: 'terminates on',
      description: `TYPE   subject is an agreement; value is a termination date/condition
ADMIT  text states when/how the agreement terminates ("terminates 31
       December 2027", "on 90 days notice")
VALUE  the termination date/condition, verbatim ("90 days notice")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Legal inputs describe AGREEMENTS or contractual relationships.
Treat the named agreement (or the parties) as the SUBJECT entity. Prefer the
legal__* predicates for governing law (legal__governed_by), parties
(legal__party_to), obligations/covenants (legal__obligation), effective date
(legal__effective_from), and termination (legal__terminates_on). Copy
jurisdictions, party names, dates, and obligation clauses VERBATIM — "England
and Wales" not "UK law", "30 days" not "a month". When two named parties are in
an agreement, emit an edge between them in addition to the party facts.`,
    fewShot: [
      {
        text: 'This Agreement between Acme Corp and Beta LLC is governed by the laws of Delaware and effective 1 January 2026.',
        note: "→ legal__party_to='Acme Corp', legal__party_to='Beta LLC', legal__governed_by='Delaware', legal__effective_from='1 January 2026'; edge (Acme Corp, party_with, Beta LLC).",
      },
      {
        text: 'The Supplier shall deliver within 30 days and must maintain insurance.',
        note: "→ legal__obligation='deliver within 30 days', legal__obligation='maintain insurance'.",
      },
      {
        text: 'The contract terminates on 90 days written notice.',
        note: "→ legal__terminates_on='90 days written notice'.",
      },
    ],
  },
  // The domain perception contract (docs/domain-packs.md). Declarative data
  // only — consumed by MemoryModelReaderService for installed tenants.
  // Text-only: no modalities/processors/rawEvidence, so no consent surface.
  memoryModel: {
    sceneSchemas: [
      {
        id: 'negotiation_session',
        description:
          'A contract negotiation session: terms, redlines, and concessions on an agreement are discussed between the parties.',
        cues: ['redline', 'negotiation', 'counterparty', 'term sheet'],
      },
      {
        id: 'execution',
        description:
          'An execution event: an agreement is signed, countersigned, or comes into force.',
        cues: ['signed', 'executed', 'countersigned', 'came into force'],
      },
    ],
    stateModels: [
      {
        id: 'matter_lifecycle',
        subjectType: 'matter',
        states: ['opened', 'discovery', 'settled', 'judged', 'closed'],
        transitions: [
          { from: 'opened', to: 'discovery' },
          { from: 'discovery', to: 'settled' },
          { from: 'discovery', to: 'judged' },
          { from: 'opened', to: 'settled' },
          { from: 'settled', to: 'closed' },
          { from: 'judged', to: 'closed' },
        ],
      },
      {
        id: 'agreement_lifecycle',
        subjectType: 'agreement',
        states: ['drafted', 'negotiated', 'executed', 'effective', 'terminated', 'expired'],
        transitions: [
          { from: 'drafted', to: 'negotiated' },
          { from: 'negotiated', to: 'executed' },
          { from: 'drafted', to: 'executed' },
          { from: 'executed', to: 'effective' },
          { from: 'effective', to: 'terminated' },
          { from: 'effective', to: 'expired' },
        ],
      },
      {
        id: 'obligation_lifecycle',
        subjectType: 'obligation',
        states: ['owed', 'performed', 'waived', 'breached'],
        transitions: [
          { from: 'owed', to: 'performed' },
          { from: 'owed', to: 'waived' },
          { from: 'owed', to: 'breached' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'governed by', prefer: ['governed_by'], zoom: ['facts'], weight: 0.6 },
      { cue: 'party', prefer: ['party_to'], zoom: ['facts'], weight: 0.5 },
      { cue: 'shall', prefer: ['obligation'], zoom: ['facts'], weight: 0.6 },
      { cue: 'effective', prefer: ['effective_from'], zoom: ['facts'], weight: 0.6 },
      { cue: 'terminates', prefer: ['terminates_on'], zoom: ['facts'], weight: 0.7 },
      { cue: 'notice period', prefer: ['terminates_on'], zoom: ['facts'], weight: 0.6 },
      {
        cue: 'breach',
        prefer: ['obligation', 'terminates_on'],
        zoom: ['episodes', 'facts'],
        weight: 0.7,
      },
    ],
    // Term claims go stale as contracts renew, terminate, or are amended —
    // serve termination and effective-date claims recency-checked.
    verificationRules: [
      { claimPattern: 'terminat', requires: 'recency_check' },
      { claimPattern: 'effective', requires: 'recency_check' },
    ],
    retentionHints: [
      { predicateOrScene: 'governed_by', hint: 'durable' },
      { predicateOrScene: 'party_to', hint: 'durable' },
      { predicateOrScene: 'effective_from', hint: 'durable' },
      { predicateOrScene: 'terminates_on', hint: 'durable' },
      { predicateOrScene: 'obligation', hint: 'standard' },
      { predicateOrScene: 'execution', hint: 'durable' },
      { predicateOrScene: 'negotiation_session', hint: 'ephemeral' },
    ],
  },
  evalFixtures: [
    {
      id: 'governing-law',
      description: 'the governing law is extracted',
      text: 'This Agreement is governed by the laws of Delaware.',
      expect: { facts: [{ predicate: 'governed_by', objectIncludes: 'Delaware' }] },
    },
    {
      id: 'obligation',
      description: 'a contractual obligation is captured',
      text: 'The Supplier shall deliver within 30 days.',
      expect: { facts: [{ predicate: 'obligation', objectIncludes: '30 days' }] },
    },
    {
      id: 'term',
      description: 'the effective date is captured',
      text: 'This Agreement is effective 1 January 2026.',
      expect: { facts: [{ predicate: 'effective_from', objectIncludes: '1 January 2026' }] },
    },
    {
      id: 'party',
      description: 'a named party to the agreement is captured',
      text: 'This Agreement is between Acme Corp and Beta LLC.',
      expect: { facts: [{ predicate: 'party_to', objectIncludes: 'Acme Corp' }] },
    },
    {
      id: 'termination',
      description: 'the termination condition is captured verbatim',
      text: 'The contract terminates on 90 days written notice.',
      expect: { facts: [{ predicate: 'terminates_on', objectIncludes: '90 days' }] },
    },
  ],
};
