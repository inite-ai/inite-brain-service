-- 0154_edge_unique_scoped — edge uniqueness is per scope.
--
-- Rebuilds edge_unique_idx (0002: in, out, kind) as (in, out, kind,
-- scopeKey): the same relation may exist tenant-globally and in a
-- user's personal memory, and two users may each hold it; within one
-- scope it stays single. Separate file from 0153 on purpose — see there.
REMOVE INDEX IF EXISTS edge_unique_idx ON knowledge_edge;
DEFINE INDEX IF NOT EXISTS edge_user_idx ON knowledge_edge FIELDS userId;
DEFINE INDEX IF NOT EXISTS edge_unique_idx ON knowledge_edge FIELDS in, out, kind, scopeKey UNIQUE;
