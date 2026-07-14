-- 0061_community_build_state — tenant-level short-circuit for the
-- nightly community builder.
--
-- CommunityBuilderService.run() loaded EVERY live edge into process
-- memory and re-ran label propagation each night, even when the graph
-- had not changed since the last pass — the per-cluster watermark only
-- skipped the summarize/embed step. At 1M edges that is a ~200+ MB JS
-- materialisation per tenant per night for a no-op.
--
-- One row per tenant DB (fixed id, UPSERTed after each full pass)
-- records the live-edge signature (count + newest createdAt + the
-- minSize knob). The next run probes the same signature with one
-- aggregate query and skips the load+cluster when nothing moved.
-- Invalidation is covered by the count; new edges by maxEdgeAt; a
-- changed COMMUNITIES_MIN_SIZE by minSize.

DEFINE TABLE IF NOT EXISTS community_build_state SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS liveEdgeCount ON community_build_state TYPE int;
DEFINE FIELD IF NOT EXISTS maxEdgeAt     ON community_build_state TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS minSize       ON community_build_state TYPE int;
DEFINE FIELD IF NOT EXISTS updatedAt     ON community_build_state TYPE datetime DEFAULT time::now();
