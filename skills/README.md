# brain skills bundle

Six Anthropic-format skills that teach an AI agent how to use the INITE
Brain service through its MCP endpoint. Bundled into a tarball, installed
into `~/.claude/skills/` by `install.sh`.

## Install (one-liner)

```sh
curl -fsSL https://brain.inite.ai/install.sh | sh
```

Optional flags:

- `--target project` — install into `$PWD/.claude/skills/` instead of `$HOME`
- `--key <api-key>` — ping a probe so the dashboard marks "skills installed" complete

## What's inside

| Skill | Activates when… | What it does |
| --- | --- | --- |
| `brain-search` | The user asks brain to find / look up / search knowledge | Routes through `search_knowledge` (+ `search_multi_hop` / `synthesize`) with predicate + asOf hints |
| `brain-recall` | The user asks for an entity's profile, history, or connections | Combines `summarize_entity` + `get_entity_profile` + `get_entity_timeline` + `find_related_entities` + `get_competing_facts` |
| `brain-bitemporal` | The user asks "what did we know on X" / "what changed since Y" | Teaches `asOf` semantics, `memory_diff`, validFrom/validUntil, retracted-row handling |
| `brain-write` | The user wants to record / merge / revise structured knowledge | Routes through `record_fact` (with `conversationId`/`evidence[]` grounding) / `ingest_document` / `link_entities` / `retract_fact` / `record_feedback` with `detect_contradiction` preflight |
| `brain-conflict` | The user surfaces a disagreement or two facts in COMPETING status | Adjudication workflow via `get_competing_facts` + `detect_contradiction` |
| `brain-mcp-setup` | The user is setting up brain MCP for the first time | Step-by-step config for Claude Desktop, Cursor, Goose v2, Aider, Continue.dev, n8n, raw SDK |

## Layout

```
skills/
├── VERSION              ← single semver source of truth
├── CHANGELOG.md         ← Keep-a-Changelog
├── install.sh           ← tarball downloader → ~/.claude/skills/
├── brain-search/SKILL.md
├── brain-recall/SKILL.md
├── brain-bitemporal/SKILL.md
├── brain-write/SKILL.md
├── brain-conflict/SKILL.md
└── brain-mcp-setup/SKILL.md
```

## Updating a skill

1. Edit `<skill>/SKILL.md` (frontmatter + body).
2. `pnpm skills:bump` — patch-bumps `VERSION`, appends a CHANGELOG entry, rebuilds `src/data/skill-versions.json`.
3. `pnpm skills:pack` — produces `brain-landing/public/skills.tar.gz` for the next deploy.

## Adding a new skill

1. Create `skills/<new-name>/SKILL.md` with `name` + `description` frontmatter (Anthropic Skills format).
2. Update this README's table and `CHANGELOG.md` under `### New skills`.
3. Run `pnpm skills:bump --note "feat(<new-name>): …"` then `pnpm skills:pack`.

## Format

Each `SKILL.md` is plain markdown with a YAML frontmatter:

```yaml
---
name: brain-search
description: One-line summary the agent reads before deciding to activate this skill.
---

# Heading and instructions follow — pure markdown.
```

Claude reads these natively when they land in `~/.claude/skills/`. No
runtime wrapper, no JS hook, no MCP wiring — the MCP tools live in
brain-service itself, the skill is just the agent's how-to-use-them brief.
