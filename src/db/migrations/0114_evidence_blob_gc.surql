-- 0114: durable blob-GC outbox for hard erasure.
--
-- User-forget deletes Evidence Plane rows immediately, but blob deletion is
-- external I/O and cannot participate in the SurrealDB mutation. Before the
-- rows (and their only storageRef pointers) disappear, the forget path writes
-- one queue row per blob. Successful immediate deletes remove their queue
-- rows; failures remain for the nightly evidence reconciliation pass. This
-- turns a transient adapter/filesystem failure from a manual GDPR incident
-- into durable, retryable work.
--
-- No CHANGEFEED / event: storageRef is deletion infrastructure, and retaining
-- it in the audit mirror after the queue row is drained would defeat erasure.

DEFINE TABLE IF NOT EXISTS evidence_blob_gc SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS storageRef ON evidence_blob_gc TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON evidence_blob_gc TYPE string
  ASSERT $value INSIDE ['user_forget', 'tenant_forget', 'retention'];
DEFINE FIELD IF NOT EXISTS attempts ON evidence_blob_gc TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS queuedAt ON evidence_blob_gc TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS lastAttemptAt ON evidence_blob_gc TYPE option<datetime>;

-- Single-field indexes only (same SurrealDB 3.2.4 DELETE planner discipline as
-- 0109). Not UNIQUE: a crash after enqueue but before row erasure may enqueue
-- the same ref again on retry; draining either row is idempotent and both are
-- removed together after the bytes are confirmed gone.
DEFINE INDEX IF NOT EXISTS evidence_blob_gc_ref_idx ON evidence_blob_gc FIELDS storageRef;
DEFINE INDEX IF NOT EXISTS evidence_blob_gc_queued_idx ON evidence_blob_gc FIELDS queuedAt;
