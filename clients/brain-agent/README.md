# @inite/brain-agent

The INITE Brain **local agent**: reads the folders, git repositories and
stdio MCP servers on *this* machine as sources for a brain. The agent walks
and fetches here; the brain keeps the books (catalogue, revisions, deletes,
facts) there. Nothing has to be mounted into the server, no server-side
egress fence applies — this host *is* the LAN, the laptop, the CI runner.

## Install — on a laptop, a server, a box on the LAN

In **Admin → Connections → Local agents → Set up an agent** name the
machine and press *Issue a key*: the brain mints a `brain:write` key
labelled `agent:<id>` (a write key of the tenant — never an admin one)
and hands back the command with everything filled in:

```bash
npx @inite/brain-agent install --url https://brain.example.com --key brain_… --agent laptop-1
#   optional: --roots /Users/me/Documents:/srv/docs   (BRAIN_AGENT_ROOTS)
#             --every 15                               (minutes; default 5)
```

`install` writes `~/.config/brain-agent/config.json` (mode 0600 — the
only place the key lives) and registers a service that syncs every few
minutes and survives reboots: a **launchd** user agent on macOS
(`~/Library/LaunchAgents/ai.inite.brain-agent.plist`, log in
`~/Library/Logs/brain-agent/`) or a **systemd** user unit on Linux
(`~/.config/systemd/user/brain-agent.service`, `journalctl --user -u
brain-agent`; on a headless box `loginctl enable-linger $USER`). Neither
file carries the key. Windows has no service manager yet — run `sync
--every` under Task Scheduler.

```bash
brain-agent status        # is the service running, what it syncs, the last log lines
brain-agent doctor        # config, key, brain, roots, git — each with a verdict; exit 2 on a failure
brain-agent sync          # one pass now (what the service runs)
brain-agent uninstall     # stop and remove the service; --purge removes the config too
```

Needs Node 20+ and, for repositories, git on PATH. The environment
(`BRAIN_URL`, `BRAIN_API_KEY`, `BRAIN_AGENT_ID`, `BRAIN_AGENT_ROOTS`)
overrides the config file field by field — a CI job passes the key that
way and never writes a file; `BRAIN_AGENT_HOME` moves the config dir.

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
| `BRAIN_AGENT_HOME` | where the config file lives (default `$XDG_CONFIG_HOME/brain-agent`, else `~/.config/brain-agent`) |

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
`config: { repo: "." }` (the working directory of the job); `include`
narrows the walk by prefix or glob (`["docs/**", "README.md", "adr/????-*.md"]`),
`extensions` defaults to the docs extensions. Structure —
decisions, ownership, version pins — stays with the repo indexer
(`pnpm indexer:repo`); one repo, two shapes.

## Exit codes

`0` every run succeeded · `2` at least one run failed (the brain recorded
the error on the connection) · `1` the agent could not start (no key, no
URL, an unreachable brain).
