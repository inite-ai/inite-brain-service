-- 0092: strategy_memory — the ReasoningBank-shape strategy lane
-- (docs/roadmap/sota-gap-build-2026-08.md G4). Procedural "how to
-- answer" lessons distilled from judged post-mortems. Advice, not
-- evidence: a SEPARATE table by design, so leakage into fact
-- retrieval is structural — no fact-lane query can return a strategy
-- row, the table is never unioned with knowledge_fact lanes, and it
-- is excluded from grounding/provenance (the field rule: procedural
-- memory lives in a separate store, separate retrieval call,
-- separate prompt section).
--
-- Item shape (ReasoningBank, arXiv 2509.25140): title + situation
-- (preconditions — question class / genre / temporal shape) +
-- strategy (2-5 sentences of why/when, never replayable step
-- scripts; failures become preventative lessons) + polarity
-- do|avoid. Lifecycle (Memp deprecate-on-feedback + ExpeL vote
-- counters): candidate -> active on confirmation; the evidence
-- counters feed auto-deprecation (nContradict >= 2 or 90d without
-- validation) in the distill cron sweep.

DEFINE TABLE IF NOT EXISTS strategy_memory SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS companyId ON strategy_memory TYPE string;
DEFINE FIELD IF NOT EXISTS title ON strategy_memory TYPE string;
-- Preconditions: which question class / genre / temporal shape this
-- item applies to — the generator is told to assess applicability.
DEFINE FIELD IF NOT EXISTS situation ON strategy_memory TYPE string;
-- 2-5 sentences, why/when — strategy-level, never step scripts.
DEFINE FIELD IF NOT EXISTS strategy ON strategy_memory TYPE string;
DEFINE FIELD IF NOT EXISTS polarity ON strategy_memory TYPE string
  ASSERT $value INSIDE ['do', 'avoid'];
DEFINE FIELD IF NOT EXISTS status ON strategy_memory TYPE string
  ASSERT $value INSIDE ['candidate', 'active', 'deprecated'];
-- {source, runIds, nSupport, nContradict, lastValidatedAt} — open
-- shape so distillation sources can annotate without a migration.
DEFINE FIELD IF NOT EXISTS evidence ON strategy_memory TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS embedding ON strategy_memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS scope ON strategy_memory TYPE string
  ASSERT $value INSIDE ['tenant', 'global'];
DEFINE FIELD IF NOT EXISTS createdAt ON strategy_memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON strategy_memory TYPE datetime DEFAULT time::now();

-- Serving reads filter (companyId, status='active').
DEFINE INDEX IF NOT EXISTS strategy_company_status_idx ON strategy_memory
  FIELDS companyId, status;
-- v1 dedup guard: one item per title per tenant (the dedup-merge
-- ADD/UPDATE/NOOP pass keys on similarity, this pins exact repeats).
DEFINE INDEX IF NOT EXISTS strategy_company_title_idx ON strategy_memory
  FIELDS companyId, title UNIQUE;
