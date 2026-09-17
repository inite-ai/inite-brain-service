# @inite/brain-agent

The INITE Brain **local agent**: reads the folders, git repositories and
stdio MCP servers on *this* machine as sources for a brain. The agent walks
and fetches here; the brain keeps the books (catalogue, revisions, deletes,
facts) there. Nothing has to be mounted into the server, no server-side
egress fence applies — this host *is* the LAN, the laptop, the CI runner.

```bash
npm i -g @inite/brain-agent

export BRAIN_URL=https://brain.example.com
export BRAIN_API_KEY=brain_…            # a tenant WRITE key (brain:write) — never an admin key

brain-agent list                        # what this agent is asked to sync
brain-agent sync                        # one pass over every connection pointed at agent:<hostname>
brain-agent sync --agent laptop-1 --every 15   # keep syncing every 15 minutes
brain-agent sync --connection source_connection:… --full
```

## How it fits

1. An operator installs a source pack (`file_memory`, `web_memory`,
   `code_memory` is builtin) and, in **Admin → Connections → Connect**,
   picks *runs on: local agent* and names the agent id. The connection's
   `host` becomes `agent:<id>`.
2. The agent asks the brain which connections are its
   (`GET /v1/source-connections?host=agent:<id>`), and for each one runs
   the connector the pack entry names:

   | Pack entry | Agent connector | Reads | Revision |
   |---|---|---|---|
   | `native: fs` (`file_memory/folder`, `folder_media`) | `fs` | a directory on this machine — notes, a vault, Downloads, an OS-mounted share | `mtime:size` |
   | `native: git` (`code_memory/repo_docs`) | `git` | the **committed** text docs of a repository (README, docs/**, ADRs); git runs here, never in the brain | the blob sha |
   | `mcp` / `transport: stdio` | `mcp` | a local MCP server the pack names (spawned per run) — its resources | `annotations.lastModified` |

3. One run = `begin` → deltas in batches (the brain answers with what
   changed) → the changed items' content → `finish` with the checkpoint.
   A run is a `source_sync` job on the brain (actor `agent:<id>`), visible
   in **Admin → Jobs**; the summary is its result.

What leaves the machine is text (or the bytes of a binary-shaped item),
**redacted first**: cloud keys, platform tokens, private-key blocks, bearer
headers and `secret=value` assignments are replaced by `[redacted:<kind>]`
markers. `--no-redact` turns that off for a source you know is clean.

## Environment

| Variable | Meaning |
|---|---|
| `BRAIN_URL` | the brain's base URL |
| `BRAIN_API_KEY` | a `brain:write` key of the tenant |
| `BRAIN_AGENT_ID` | this agent's id (default: the hostname); `--agent` overrides |
| `BRAIN_AGENT_ROOTS` | optional `:`-separated allowlist of directories `fs` roots must be under — set it when the agent runs for others (a CI box, a shared server); unset on your own laptop |

## In CI — a repository's docs after every push

```yaml
# .github/workflows/brain-sync.yml
name: brain sync
on:
  push:
    branches: [main]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # the git connector reads the committed tree + log
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g @inite/brain-agent
      - run: brain-agent sync --agent ci-${{ github.repository_owner }}
        env:
          BRAIN_URL: ${{ vars.BRAIN_URL }}
          BRAIN_API_KEY: ${{ secrets.BRAIN_API_KEY }}
```

Point a `code_memory/repo_docs` connection at `agent:ci-<owner>` with
`config: { repo: "." }` (the working directory of the job). Structure —
decisions, ownership, version pins — stays with the repo indexer
(`pnpm indexer:repo`); one repo, two shapes.

## Exit codes

`0` every run succeeded · `2` at least one run failed (the brain recorded
the error on the connection) · `1` the agent could not start (no key, no
URL, an unreachable brain).
