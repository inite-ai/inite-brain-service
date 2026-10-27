@AGENTS.md

## Claude Code notes

- Project skills: `/contribute` (idea → spec → code → gates → PR, for anyone,
  engineer or not) and `/spec-idea` (turn an idea into a filed issue, no
  code). Both live in `.claude/skills/`.
- The `skills/` directory and `plugins/inite-brain/` are the product (skills
  for agents that _use_ Brain as memory), not instructions for working on
  this repo.
- `.claude/settings.local.json`, `.claude/worktrees/` and `.claude/*.lock`
  are per-machine and gitignored; never commit them.
- The e2e suites start Docker containers (testcontainers). Ask before running
  them on someone's laptop; unit + socket tests are always safe.
