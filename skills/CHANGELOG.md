# Skills Changelog

All notable changes to the bundled `skills/` directory.

The bundle ships as a single versioned unit (semver in `skills/VERSION`).
No per-skill versions — bump-skill-versions patch-bumps the bundle when
any file under `skills/<name>/**` changes.

## [0.2.0] — 2026-06-23

MCP surface picked up four new tools — skills point at them. Minor
update across `brain-search`; no breaking changes to existing skill
behaviour.

### MCP tools (now live in `src/mcp/mcp.service.ts`)

- `search_multi_hop` — planner-LLM-driven chained search with the
  running entity set anchored across hops. Use for questions that
  combine evidence across turns / sessions ("tenants who complained
  in April AND upgraded after"). Read scope.
- `synthesize` — corrective-RAG with the strict / lenient / off
  guardrail trio + claim-level faithfulness verifier. Read scope.
- `link_entities` — declare a typed edge between two entities. The
  `identity_of` kind merges two records of the same person across
  verticals; other kinds (`paid_for`, `mentioned_in`, …) participate
  in PPR / SubgraphRAG context. Write scope.
- `forget_entity` — GDPR-grade hard cascade with an HMAC tombstone.
  Reason enum is locked (`gdpr_request` / `tenant_offboarding` /
  `operator_request`); requestId is required for the audit trail.
  Admin scope.

### Skill updates

- `brain-search` — calls out when to escalate to `search_multi_hop`
  vs `synthesize` vs the one-shot `search_knowledge`; companion-
  tool list now includes the four new tools.

## [0.1.0] — 2026-05-22

Initial brain skills bundle.

### New skills

- `brain-search` — semantic + bitemporal search workflow for AI agents
- `brain-recall` — entity profile + timeline + connections workflow
- `brain-bitemporal` — formulating `asOf` queries and reading retracted facts
- `brain-mcp-setup` — connect a new MCP client to brain (Claude Desktop / Cursor / Goose)
