# INITE Brain — Claude Desktop extension

A one-click `.mcpb` bundle that connects Claude Desktop to your INITE Brain
workspace with an API key. Install by double-clicking `inite-brain.mcpb`,
or Settings → Extensions → Install extension; Desktop asks for the key
(issue one at <https://brain.inite.ai/en/app/keys>) and keeps it in the OS
keychain.

The bundle is the `@inite/brain-mcp` stdio shim (`../brain-mcp`) with its
dependencies, so every tool the key's scopes allow is passed through
unchanged; the workspace comes from the key.

You may not need it: Claude Desktop can also add `https://brain.inite.ai/mcp`
as a connector (Settings → Connectors) and sign in with OAuth, no key to
copy. The extension is for keys — a service account, a self-hosted brain,
or an organization that hands out keys rather than accounts.

Build: `./build.sh` → `dist/inite-brain.mcpb`. Claude's directory no longer
lists desktop extensions, so the file is distributed directly (a release
asset), not submitted.
