import type { DomainPackManifest } from './manifest';

/**
 * Source pack: FILES. DISTRIBUTABLE (installed per-tenant from
 * `packs/file-memory.pack.json`, NOT in BUILTIN_PACKS). The first
 * first-party source pack after the retrofitted `code_memory`
 * (docs/roadmap/raw-evidence-sources-2026-09.md, W1): it is the CARRIER of
 * the `fs` source entries — without a pack declaring `native: fs` no
 * folder can be connected — plus the vocabulary a folder of documents
 * yields, the derivable class the drift sweep re-verifies, and the media
 * contract that lets the binary door process PDFs and images.
 *
 * Two source entries, one root, two shapes: `folder` reads text-like
 * files as documents (markdown, text, csv, json, yaml, html, code);
 * `folder_media` hands PDFs and images to the evidence door (the
 * evidence → document bridge carries a PDF's text on). An operator
 * connects one or both to the same directory.
 *
 * The derivable class: `located_in` and `last_modified` are statements
 * the filesystem re-derives exactly, so they are bound to the revision
 * (mtime + size) they were read at and go back for re-verification when
 * the file moves on — the code_memory precedent. `describes`,
 * `defines_term` and `references` are what the text SAYS, which does not
 * become false because the file was edited, and are therefore not
 * swept.
 *
 * Bump `version` to update.
 */
export const FILE_MEMORY_PACK: DomainPackManifest = {
  id: 'file_memory',
  version: '0.1.0',
  description:
    'Files as memory — what a folder of documents describes, defines and references, bound to the file revision it was read at; the source pack that connects local and mounted folders.',
  predicates: [
    {
      localId: 'describes',
      displayLabel: 'describes',
      description: `TYPE   subject is a document/file; value is a subject the document is about
ADMIT  the text is clearly ABOUT a named thing — a project, a system, a
       process, a person's role, a product ("this runbook covers the
       payments gateway", a README's opening line)
VALUE  the subject, verbatim as named ("payments gateway")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'defines_term',
      displayLabel: 'defines term',
      description: `TYPE   subject is a document/file; value is a term the document defines
ADMIT  the text gives a definition, glossary entry or "X means Y"
       ("SLA — the response-time commitment in the contract")
VALUE  the term being defined, verbatim ("SLA")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'references',
      displayLabel: 'references',
      description: `TYPE   subject is a document/file; value is another document, file or link it points to
ADMIT  the text names another document, file path or URL as something to
       read ("see docs/deploy.md", "the spec is at https://…")
VALUE  the referenced path/name/URL, verbatim ("docs/deploy.md")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'located_in',
      displayLabel: 'located in',
      description: `TYPE   subject is a document/file; value is the folder that holds it
ADMIT  DERIVABLE — the filesystem states it; from text only when the
       document names its own location ("this file lives in docs/runbooks")
VALUE  the folder path, verbatim ("docs/runbooks")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'last_modified',
      displayLabel: 'last modified',
      description: `TYPE   subject is a document/file; value is when it was last changed
ADMIT  DERIVABLE — the filesystem states it; from text only when the
       document carries its own "last updated" line
VALUE  an ISO date or the verbatim date text ("2026-09-01")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Inputs are DOCUMENTS read from files — READMEs, runbooks, notes,
specs, exports. Treat the document itself as one SUBJECT entity (its title or
file name) and extract what it is ABOUT (file_memory__describes), which terms it
DEFINES (file_memory__defines_term) and which other documents, paths or links it
REFERENCES (file_memory__references). Do NOT invent location or modification
facts from prose: file_memory__located_in and file_memory__last_modified are
derived from the filesystem and only admitted when the text states them
explicitly. Copy names, terms, paths and URLs VERBATIM.`,
    fewShot: [
      {
        text: '# Payments gateway runbook\nThis runbook covers on-call procedures for the payments gateway. See docs/alerts.md for the alert catalogue. "Settlement window" means the 02:00–04:00 UTC batch.',
        note: "document 'Payments gateway runbook' → file_memory__describes='payments gateway', file_memory__references='docs/alerts.md', file_memory__defines_term='Settlement window'.",
      },
      {
        text: 'Last updated 2026-03-01. The onboarding checklist lives in people/onboarding/.',
        note: "→ file_memory__last_modified='2026-03-01', file_memory__located_in='people/onboarding/' (both stated in the text, so admitted).",
      },
    ],
  },
  memoryModel: {
    sceneSchemas: [
      {
        id: 'document_review',
        description:
          'A document is read, discussed or revised: what it says, what is missing, what changed.',
        cues: ['runbook', 'readme', 'spec', 'updated the doc', 'see the notes'],
      },
    ],
    attentionHints: [
      { cue: 'covers', prefer: ['describes'], zoom: ['facts'], weight: 0.5 },
      { cue: 'means', prefer: ['defines_term'], zoom: ['facts'], weight: 0.6 },
      { cue: 'see ', prefer: ['references'], zoom: ['facts'], weight: 0.5 },
      { cue: 'lives in', prefer: ['located_in'], zoom: ['facts'], weight: 0.5 },
    ],
    verificationRules: [
      // THE DERIVABLE CLASS: the filesystem re-derives where a file is and
      // when it changed exactly, at any moment. Bound to the revision the
      // connector read them at; re-verified when the file moves on.
      { requires: 'source_version_match', appliesTo: ['located_in', 'last_modified'] },
    ],
    retentionHints: [
      { predicateOrScene: 'describes', hint: 'durable' },
      { predicateOrScene: 'defines_term', hint: 'durable' },
      { predicateOrScene: 'references', hint: 'standard' },
      { predicateOrScene: 'located_in', hint: 'standard' },
      { predicateOrScene: 'last_modified', hint: 'ephemeral' },
      { predicateOrScene: 'document_review', hint: 'ephemeral' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // A folder holds PDFs and images next to its text. Document text
    // extraction turns a PDF into a document (through the evidence →
    // document bridge); image metadata is a header read. OCR is not
    // requested here — it is CPU-heavy and an operator opt-in elsewhere.
    // rawEvidence is DELIBERATELY ABSENT (omission = deny): a folder can
    // hold anything, so raw bytes never serve through this pack.
    modalities: ['text', 'document', 'image'],
    processors: [
      { id: 'document_text', modality: 'document', produces: ['text'] },
      { id: 'image_metadata', modality: 'image', produces: ['caption'] },
    ],
  },
  // ── Sources (the source plane) ───────────────────────────────────────
  // Same connector, two shapes: an operator points both at one directory.
  sources: [
    {
      id: 'folder',
      kind: 'native',
      connector: 'fs',
      shape: 'document',
      title: 'Folder (text documents)',
      description:
        'Text-like files under a directory (markdown, text, csv, json, yaml, html, code) read as documents. config: { root, extensions?, excludeDirs?, maxFiles?, maxFileBytes? }.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: 'manual' },
    },
    {
      id: 'folder_media',
      kind: 'native',
      connector: 'fs',
      shape: 'binary',
      title: 'Folder (PDFs and images)',
      description:
        'PDFs and images under a directory handed to the evidence plane (needs the evidence substrate + broker; the bridge carries a PDF’s text into facts). config: { root, extensions?, excludeDirs?, maxFiles?, maxFileBytes? }.',
      defaults: { contentPolicy: 'bytes', deletePolicy: 'close', schedule: 'manual' },
    },
  ],
  evalFixtures: [
    {
      id: 'describes',
      description: 'what a document is about is extracted',
      text: 'This runbook covers on-call procedures for the payments gateway.',
      expect: { facts: [{ predicate: 'describes', objectIncludes: 'payments gateway' }] },
    },
    {
      id: 'defines',
      description: 'a defined term is captured',
      text: '"Settlement window" means the 02:00–04:00 UTC batch.',
      expect: { facts: [{ predicate: 'defines_term', objectIncludes: 'Settlement window' }] },
    },
    {
      id: 'references',
      description: 'a referenced document is captured verbatim',
      text: 'See docs/alerts.md for the alert catalogue.',
      expect: { facts: [{ predicate: 'references', objectIncludes: 'docs/alerts.md' }] },
    },
  ],
};
