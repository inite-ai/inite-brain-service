/**
 * Ready-to-paste client configuration for a specific key.
 *
 * The old Keys screen showed one snippet with `brain_YOUR_API_KEY` and
 * `YOUR_COMPANY_ID` in it, which nobody could paste anywhere: the two
 * values it asked for were exactly the two the product never told you.
 * These are generated from the issued key, its tenant and the MCP URL
 * the backend reports, so every one of them works as-is.
 *
 * Only clients whose current configuration shape we have verified are
 * listed. A wrong snippet costs more than a missing one — the setup
 * docs carry the long tail.
 */

export interface ClientSnippet {
  id: string;
  label: string;
  /** Where the snippet goes — a file path, or how it is run. */
  target: string;
  code: string;
}

export interface SnippetInput {
  /** The plaintext key, or a placeholder when showing an existing key. */
  key: string;
  companyId: string;
  mcpUrl: string;
}

export function clientSnippets({ key, companyId, mcpUrl }: SnippetInput): ClientSnippet[] {
  const base = mcpUrl.replace(/\/mcp\/[^/]+$/, '');
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      target: 'terminal',
      code: `claude mcp add --transport http brain ${mcpUrl} \\\n  --header "Authorization: Bearer ${key}"`,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      target: 'claude_desktop_config.json',
      code: JSON.stringify(
        {
          mcpServers: {
            brain: {
              command: 'npx',
              args: ['-y', '@inite/brain-mcp'],
              env: {
                BRAIN_API_KEY: key,
                BRAIN_COMPANY_ID: companyId,
                ...(base === 'https://brain.inite.ai' ? {} : { BRAIN_BASE_URL: base }),
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      target: '.cursor/mcp.json',
      code: JSON.stringify(
        {
          mcpServers: {
            brain: {
              url: mcpUrl,
              transport: 'http',
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      target: '.vscode/mcp.json',
      code: JSON.stringify(
        {
          servers: {
            brain: {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      target: '~/.codex/config.toml',
      code:
        `[mcp_servers.brain]\n` +
        `url = "${mcpUrl}"\n` +
        `bearer_token_env_var = "BRAIN_API_KEY"\n\n` +
        `# then, in your shell profile:\n` +
        `export BRAIN_API_KEY="${key}"`,
    },
    {
      id: 'goose',
      label: 'Goose',
      target: '~/.config/goose/config.yaml',
      code:
        `extensions:\n` +
        `  brain:\n` +
        `    type: streamable_http\n` +
        `    uri: ${mcpUrl}\n` +
        `    headers:\n` +
        `      Authorization: Bearer ${key}\n` +
        `    enabled: true`,
    },
    {
      id: 'rest',
      label: 'REST',
      target: 'terminal',
      code:
        `export BRAIN_KEY="${key}"\n\n` +
        `curl --fail-with-body -X POST ${base}/v1/search \\\n` +
        `  -H "Authorization: Bearer $BRAIN_KEY" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{ "query": "hello", "limit": 3 }'`,
    },
  ];
}
