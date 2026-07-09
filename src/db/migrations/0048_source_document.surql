-- 0048_source_document — the Source layer: normalized document container.
--
-- Ingest architecture split (Source → Indexer → Candidates → Brain), part 1.
-- Until now the brain only ever saw 16K free-text mentions or pre-typed
-- facts; the origin document was invisible, so nothing could be re-read
-- when a new domain pack landed, and multiple extractors had no shared
-- origin identity. This table is that origin.
--
-- Scope decisions (deliberate):
--   * The brain stores NORMALIZED TEXT only (post-connector, post-
--     redactPii). Raw binary (PDF bytes, email MIME) stays with the
--     connector — `originUri` is the pointer back. "Brain must not know
--     what a PDF is."
--   * Content storage is OPTIONAL per request (`storeContent: false` →
--     header + contentHash only, no source_chunk rows, hasContent=false).
--     Such documents cannot be re-indexed or span-re-validated later —
--     the caller made that privacy trade explicitly.
--   * contentHash = sha256 hex of the normalized (redacted) text. It is
--     BOTH the idempotency key (UNIQUE — re-POSTing the same document
--     dedupes) AND the origin identity that migration 0050 keys
--     corroboration on (`originKey = 'doc:' + contentHash`).
--   * Chunks are ≤ 16 000 chars — equal to LLM_INPUT_LIMITS.mentionText,
--     so each chunk flows through the existing extractor clamp untouched.
--     charStart/charEnd are document coordinates: candidate spans map
--     back to the document, not just the chunk.
--   * `kind` is a plain string (pdf/markdown/email/whatsapp/github/chat/
--     other...), not an ASSERT enum — new connectors must not need a
--     migration (job_run.jobType precedent).
--   * Purge keeps the header + contentHash (idempotency and committed
--     facts' documentId pointers survive) and deletes only chunk rows.

DEFINE TABLE IF NOT EXISTS source_document SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS kind        ON source_document TYPE string;
DEFINE FIELD IF NOT EXISTS originUri   ON source_document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS title       ON source_document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS contentHash ON source_document TYPE string;
DEFINE FIELD IF NOT EXISTS charLen     ON source_document TYPE int;
DEFINE FIELD IF NOT EXISTS chunkCount  ON source_document TYPE int;
DEFINE FIELD IF NOT EXISTS hasContent  ON source_document TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS vertical    ON source_document TYPE string;
-- Connector identity (who delivered the document). NOT the fact recorder —
-- committed facts carry the INDEXER as source.recorder; the connector
-- lives here and in source.documentId provenance.
DEFINE FIELD IF NOT EXISTS recorder    ON source_document TYPE option<string>;
-- The document's own timestamp (meeting date, email sent-at…) — becomes
-- the committed facts' validFrom.
DEFINE FIELD IF NOT EXISTS occurredAt  ON source_document TYPE datetime;
DEFINE FIELD IF NOT EXISTS meta        ON source_document TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS piiRedacted ON source_document TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS status      ON source_document TYPE string DEFAULT 'received'
  ASSERT $value INSIDE ['received','indexing','indexed','committed','failed','purged'];
DEFINE FIELD IF NOT EXISTS retainUntil ON source_document TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS createdAt   ON source_document TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS source_document_hash_idx   ON source_document FIELDS contentHash UNIQUE;
DEFINE INDEX IF NOT EXISTS source_document_status_idx ON source_document FIELDS status;

DEFINE TABLE IF NOT EXISTS source_chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS docId     ON source_chunk TYPE record<source_document>;
DEFINE FIELD IF NOT EXISTS seq       ON source_chunk TYPE int;
DEFINE FIELD IF NOT EXISTS text      ON source_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS charStart ON source_chunk TYPE int;
DEFINE FIELD IF NOT EXISTS charEnd   ON source_chunk TYPE int;

DEFINE INDEX IF NOT EXISTS source_chunk_doc_idx ON source_chunk FIELDS docId, seq UNIQUE;
