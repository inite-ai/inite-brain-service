-- 0087: conversation_digest per-user policy metadata (V11 item 10
-- slice; audit 2026-08-19 P1 follow-up).
--
-- Digests are tenant-global derived state folded from WHOLE
-- conversations — before this migration the read path had to fail
-- closed for any user-scoped caller because a digest could narrate
-- other users' turns with no per-row fence to check.
--
-- userScopes — the distinct non-null episode userIds seen in the
-- folded window, stamped by the window deriver at persist time.
-- Empty/NONE = fully tenant-global content (every folded episode was
-- tenant-global). The digest lane's read policy is fail-closed:
--   * tenant-global caller (no userId) — sees everything (M2M callers
--     already read the whole tenant, unchanged);
--   * user-scoped caller — sees only digests whose userScopes is
--     empty/NONE (purely tenant-global content) or equals [that user]
--     exactly. A digest folded from ANY other user's episodes is
--     never exposed to a user-scoped caller — mixed-scope included.

DEFINE FIELD IF NOT EXISTS userScopes ON conversation_digest TYPE option<array<string>>;
