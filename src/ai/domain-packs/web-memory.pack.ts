import type { DomainPackManifest } from './manifest';

/**
 * Source pack: THE WEB. DISTRIBUTABLE (installed per-tenant from
 * `packs/web-memory.pack.json`, NOT in BUILTIN_PACKS). The carrier of
 * the `url` source entry — a public site, a docs portal, a self-hosted
 * wiki on the LAN (with the egress double opt-in) — plus the vocabulary
 * a crawled page yields and the derivable class the drift sweep
 * re-verifies: `published_on` and `canonical_url` are what the page's
 * own metadata states and the server re-derives on every fetch; bound
 * to the revision (ETag / Last-Modified / sitemap lastmod) they were
 * read at. `describes`, `links_to` and `authored_by` are what the page
 * SAYS and are not swept.
 *
 * Bump `version` to update.
 */
export const WEB_MEMORY_PACK: DomainPackManifest = {
  id: 'web_memory',
  version: '0.1.0',
  description:
    'Web pages as memory — what a page describes, links to and who wrote it, bound to the revision it was fetched at; the source pack that connects sites, sitemaps and self-hosted wikis.',
  predicates: [
    {
      localId: 'describes',
      displayLabel: 'describes',
      description: `TYPE   subject is a web page; value is a subject the page is about
ADMIT  the page is clearly ABOUT a named thing — a product, a service, an
       organisation, a topic (a title, an opening paragraph, a heading)
VALUE  the subject, verbatim as named ("payments API")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'links_to',
      displayLabel: 'links to',
      description: `TYPE   subject is a web page; value is another page, document or URL it points to
ADMIT  the text names another page or URL as something to read ("see the
       pricing page", "https://…")
VALUE  the linked page name or URL, verbatim`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'authored_by',
      displayLabel: 'authored by',
      description: `TYPE   subject is a web page; value is its stated author or byline
ADMIT  the page carries a byline or "by …" ("By Ada Lovelace", "Author: …")
VALUE  the author as written ("Ada Lovelace")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'identifier',
      status: 'active',
    },
    {
      localId: 'published_on',
      displayLabel: 'published on',
      description: `TYPE   subject is a web page; value is its stated publication or update date
ADMIT  DERIVABLE — the page metadata / server states it; from text only when
       the page shows a date line ("Published 2026-03-01", "Updated March 1")
VALUE  an ISO date or the verbatim date text`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'canonical_url',
      displayLabel: 'canonical URL',
      description: `TYPE   subject is a web page; value is its canonical address
ADMIT  DERIVABLE — the page states a canonical link or the server redirects to it
VALUE  the URL, verbatim`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Inputs are WEB PAGES reduced to text — docs portals, wikis, product and
company pages, articles. Treat the page (its title or URL) as one SUBJECT
entity and extract what it is ABOUT (web_memory__describes), what it LINKS TO
(web_memory__links_to) and its stated AUTHOR (web_memory__authored_by). Only
admit web_memory__published_on / web_memory__canonical_url when the text states
them explicitly — they are otherwise derived from the server. Ignore navigation
chrome, cookie banners and footers. Copy names and URLs VERBATIM.`,
    fewShot: [
      {
        text: 'Payments API — reference. By Ada Lovelace. Updated 2026-03-01. See also the pricing page at https://example.com/pricing.',
        note: "page 'Payments API — reference' → web_memory__describes='Payments API', web_memory__authored_by='Ada Lovelace', web_memory__published_on='2026-03-01', web_memory__links_to='https://example.com/pricing'.",
      },
    ],
  },
  memoryModel: {
    attentionHints: [
      { cue: 'see also', prefer: ['links_to'], zoom: ['facts'], weight: 0.5 },
      { cue: 'by ', prefer: ['authored_by'], zoom: ['facts'], weight: 0.4 },
      { cue: 'updated', prefer: ['published_on'], zoom: ['facts'], weight: 0.5 },
    ],
    verificationRules: [
      // THE DERIVABLE CLASS: the server re-derives a page's date and
      // canonical address on every fetch; bound to the revision the
      // connector read them at, re-verified when the page moves on.
      { requires: 'source_version_match', appliesTo: ['published_on', 'canonical_url'] },
    ],
    retentionHints: [
      { predicateOrScene: 'describes', hint: 'durable' },
      { predicateOrScene: 'links_to', hint: 'standard' },
      { predicateOrScene: 'authored_by', hint: 'standard' },
      { predicateOrScene: 'published_on', hint: 'ephemeral' },
      { predicateOrScene: 'canonical_url', hint: 'standard' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // A site serves PDFs next to its pages (`site_media`); document text
    // extraction turns them into documents through the bridge. No image
    // modality: page images are chrome, not evidence. rawEvidence absent.
    modalities: ['text', 'document'],
    processors: [{ id: 'document_text', modality: 'document', produces: ['text'] }],
  },
  sources: [
    {
      id: 'site',
      kind: 'native',
      connector: 'url',
      shape: 'document',
      title: 'Site (pages and sitemaps)',
      description:
        'Pages named outright and every page a sitemap lists (indexes followed one level), reduced to text. config: { urls?, sitemaps?, maxPages?, sameHostOnly?, allowPrivate?, authScheme?, refetchHours?, delayMs? }; credential rides as Authorization.',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '24h' },
    },
    {
      id: 'site_media',
      kind: 'native',
      connector: 'url',
      shape: 'binary',
      title: 'Site (PDFs)',
      description:
        'PDFs a sitemap lists or that are named outright, handed to the evidence plane. Same config and credential as `site`.',
      defaults: { contentPolicy: 'bytes', deletePolicy: 'close', schedule: '24h' },
    },
  ],
  evalFixtures: [
    {
      id: 'describes',
      description: 'what a page is about is extracted',
      text: 'Payments API — reference documentation for the payments API.',
      expect: { facts: [{ predicate: 'describes', objectIncludes: 'ayments API' }] },
    },
    {
      id: 'links',
      description: 'a linked URL is captured verbatim',
      text: 'See also the pricing page at https://example.com/pricing.',
      expect: { facts: [{ predicate: 'links_to', objectIncludes: 'example.com/pricing' }] },
    },
    {
      id: 'author',
      description: 'the byline is captured',
      text: 'By Ada Lovelace.',
      expect: { facts: [{ predicate: 'authored_by', objectIncludes: 'Ada Lovelace' }] },
    },
  ],
};
