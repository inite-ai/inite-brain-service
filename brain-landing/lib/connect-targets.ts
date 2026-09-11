/**
 * Every client Brain can be installed into, and the most direct thing
 * that actually works for each.
 *
 * Kept honest on purpose. Only two clients publish a URL scheme that
 * installs an MCP server — Cursor and VS Code — so only those two get a
 * button. Claude Code and Gemini CLI install from one command; Claude
 * Desktop, claude.ai and ChatGPT add a connector through their own UI,
 * where all the user needs is the URL. A "button" that opens a settings
 * page and leaves the person to it is worse than a field that hands them
 * the exact string.
 *
 * Placeholder keys never grant access. The deeplinks carry
 * `brain_YOUR_API_KEY` because a URL is built at page-render time and
 * cannot know a key; the client's own settings screen is where it gets
 * replaced. The Keys screen builds the same links with the real value.
 */

export const MCP_URL = 'https://brain.inite.ai/mcp'

export type ConnectKind = 'deeplink' | 'command' | 'url'

export interface ConnectTarget {
  id: 'cursor' | 'vscode' | 'claude-code' | 'gemini' | 'claude' | 'chatgpt'
  label: string
  kind: ConnectKind
  /** A real install URL scheme, when the client has one. */
  href?: string
  /** The exact string to paste, when it does not. */
  copy?: string
}

const cursorConfig = {
  url: MCP_URL,
  transport: 'http',
  headers: { Authorization: 'Bearer brain_YOUR_API_KEY' },
}

const vscodeConfig = {
  name: 'brain',
  type: 'http',
  url: MCP_URL,
  headers: { Authorization: 'Bearer brain_YOUR_API_KEY' },
}

const base64 = (value: string): string =>
  typeof btoa === 'function' ? btoa(value) : Buffer.from(value).toString('base64')

export const CONNECT_TARGETS: ConnectTarget[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'command',
    // One command installs the MCP server, the six skills and the
    // lifecycle hooks together, and Claude Code prompts for the key.
    copy: '/plugin marketplace add inite-ai/inite-brain-service',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'deeplink',
    href: `cursor://anysphere.cursor-deeplink/mcp/install?name=brain&config=${encodeURIComponent(
      base64(JSON.stringify(cursorConfig)),
    )}`,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'deeplink',
    href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify(vscodeConfig))}`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'command',
    copy: 'gemini extensions install https://github.com/inite-ai/inite-brain-service',
  },
  {
    id: 'claude',
    label: 'Claude Desktop & claude.ai',
    kind: 'url',
    copy: MCP_URL,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    kind: 'url',
    // The connector contract is exactly search + fetch, which this URL
    // serves; the default surface would be refused.
    copy: `${MCP_URL}?tools=chatgpt`,
  },
]
