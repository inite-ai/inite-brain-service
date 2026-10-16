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
| `hooks/live.tsx` | A Claude Code mod (needs a version with mods): every prompt is looked up in brain before the model reads it, and what comes back rides beside it as context; a band above the prompt says what was recalled; `/brain [question]` opens a pane to ask memory directly; the status line names the workspace. |

## Settings

All six are prompted at enable time and changeable later with
`/plugin`:

- **Brain API key** (required, stored as a secret)
- **Brain base URL** — only for self-hosted deployments
- **Personal memory scope** — an end-user id, so a shared workspace key
  still keeps your memory yours
- **Recall at session start** — on by default
- **Capture sessions into memory** — on by default
- **Recall on every prompt** — on by default; at most 2.5 s per prompt,
  and nothing is attached when brain is slow or finds nothing

## What the hooks actually send

Capture sends **your** messages, never the model's output. Feeding an
assistant's own text back in as remembered fact is how memory layers
poison themselves, and the intent worth remembering — what you asked for
and why — is on your side of the conversation anyway. Brain's extractor
turns that text into facts; the raw text is stored as the episode behind
them, so every fact can be traced to the turn it came from.

Both hooks fail silent and fail open, and so does the per-prompt recall:
a recall that errors or runs past its 2.5 s is dropped and the prompt
goes on as typed. No key, no `node` on PATH, or a
brain that is down costs you nothing: the hook exits 0 and prints
nothing. A memory layer that can break a coding session is worse than no
memory layer.

To see exactly what was written, ask in-session: *"what did you just
record?"* — or call `memory_diff` over the last hour.

## What runs on your machine, and what leaves it

Everything the plugin sends goes to one place: the brain at your **Brain base URL** (`https://brain.inite.ai` unless you changed it). Nothing is sent anywhere else, and the plugin starts no other processes.

**The credential.** The only secret is the **Brain API key** you enter in the plugin settings (`userConfig`, `sensitive: true`). Claude Code keeps it in the OS keychain and hands it to the command hooks as `CLAUDE_PLUGIN_OPTION_API_KEY`, and to the MCP server as its `Authorization` header. The plugin reads no other credential, file or environment variable from your machine.

**The command hooks** (`hooks/brain-hook.sh` → `hooks/brain-hook.mjs`, Node only, no installs):

| Hook | Reads | Sends |
|---|---|---|
| `SessionStart` (recall) | The repository's `.git/config`, to name the project | `POST /v1/search` with the project name; `GET /v1/users/<id>/profile` when a personal scope is set |
| `PreCompact`, `SessionEnd` (capture) | The session transcript Claude Code passes it | `POST /v1/ingest/mention` with **your** messages only (never the model's replies, never tool output) |

**The mod** (`hooks/live.tsx`) runs no commands and makes no network requests of its own: every call goes through the plugin's `brain` MCP connection (`$.mcp.call`).

- **At session start** it calls the `workspace_status` tool, to show the workspace name and size in the status line, and registers the `/brain` command.
- **On every prompt** (`prompt.submit`), unless *Recall on every prompt* is off, it calls the `search_knowledge` tool with the prompt's text. Short prompts (under 15 characters) and slash commands are skipped. Whatever comes back is attached beside the prompt as context the model reads. The prompt itself is never changed. A recall that errors or takes longer than 2.5 s is dropped, and the prompt goes on as typed.
- **`/brain [question]`** (`command.run`) calls `search_knowledge` with the question and shows the results in a pane. No model turn is started.
- **Drawing** (`ui.render`): a band above the prompt says what was recalled; the pane shows the workspace and results. Neither sends anything.

Turn these off with **Capture sessions into memory**, **Recall at session start** and **Recall on every prompt**. The [privacy policy](https://brain.inite.ai/en/privacy) says what brain does with what it receives.

## Turning pieces off

Leave the plugin installed and flip the switches: set **Capture sessions
into memory** to off for a read-only setup, or **Recall at session
start** and **Recall on every prompt** to off if you would rather pull
memory in explicitly. Removing
the plugin removes the MCP server, the skills and the hooks together.
