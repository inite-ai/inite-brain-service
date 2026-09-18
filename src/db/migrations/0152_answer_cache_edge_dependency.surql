-- 0152_answer_cache_edge_dependency — a cached answer may rest on a
-- relation.
--
-- WHY. The answer plane cites a knowledge_edge like a fact ("[r2] Pedro
-- Lima — covers_for → Ana Costa"), and an edge now has a lifecycle the
-- serving fence reads (invalidatedAt — closed by the extractor's
-- supersedes when a turn replaces the relation). The cache used to refuse
-- any answer citing an edge, because its fact-lifecycle re-check reads
-- knowledge_fact only: such an answer was synthesized afresh on every
-- ask. The edge joins the dependency arms (0136 shape: kind, id, rev) and
-- is revalidated on every read — visible to the caller, not invalidated.
-- Same field, same type; the enum is the only change.
DEFINE FIELD OVERWRITE dependencies.*.kind ON answer_cache TYPE string
  ASSERT $value INSIDE ['belief', 'episode', 'fragment', 'scene', 'edge'];
