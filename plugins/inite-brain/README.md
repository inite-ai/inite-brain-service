# INITE Brain — Claude Code plugin

One command installs the whole integration: the MCP tool surface, the
six brain skills, and the lifecycle hooks that make memory happen
without the model having to remember to write.

```
/plugin marketplace add inite-ai/inite-brain-service
/plugin install inite-brain@inite
```

Claude Code asks for your API key at enable time (issue one at
[brain.inite.ai/en/app/keys](https://brain.inite.ai/en/app/keys); it starts
with `brain_` and is shown once) and stores it in the OS keychain rather
than in a config file.

## What you get

| Piece | What it does |
|---|---|
| `.mcp.json` | Registers `brain` as an HTTP MCP server at `<base_url>/mcp`, authenticated with your key. The tenant comes from the key, so there is nothing else to paste. |
| `skills/` | Six skills — recall, search, write, bitemporal reasoning, conflict handling, setup — so the model knows *when* to reach for memory, not just that the tools exist. |
| `hooks/` | `SessionStart` injects what brain already knows about this repo; `PreCompact` and `SessionEnd` write the session back. |

## Settings

All five are prompted at enable time and changeable later with
`/plugin`:

- **Brain API key** (required, stored as a secret)
- **Brain base URL** — only for self-hosted deployments
- **Personal memory scope** — an end-user id, so a shared workspace key
  still keeps your memory yours
- **Recall at session start** — on by default
- **Capture sessions into memory** — on by default

## What the hooks actually send

Capture sends **your** messages, never the model's output. Feeding an
assistant's own text back in as remembered fact is how memory layers
poison themselves, and the intent worth remembering — what you asked for
and why — is on your side of the conversation anyway. Brain's extractor
turns that text into facts; the raw text is stored as the episode behind
them, so every fact can be traced to the turn it came from.

Both hooks fail silent and fail open. No key, no `node` on PATH, or a
brain that is down costs you nothing: the hook exits 0 and prints
nothing. A memory layer that can break a coding session is worse than no
memory layer.

To see exactly what was written, ask in-session: *"what did you just
record?"* — or call `memory_diff` over the last hour.

## Turning pieces off

Leave the plugin installed and flip the switches: set **Capture sessions
into memory** to off for a read-only setup, or **Recall at session
start** to off if you would rather pull memory in explicitly. Removing
the plugin removes the MCP server, the skills and the hooks together.
