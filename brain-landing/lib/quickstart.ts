/** Shared, copyable examples. Placeholder keys never grant access. */
export const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    brain: {
      command: 'npx',
      args: ['-y', '@inite/brain-mcp'],
      env: {
        BRAIN_API_KEY: 'brain_YOUR_API_KEY',
        BRAIN_COMPANY_ID: 'YOUR_COMPANY_ID',
      },
    },
  },
}, null, 2)

export const QUICKSTART_EXAMPLES = [
  { id: 'mcp', label: 'MCP', filename: 'claude_desktop_config.json', code: MCP_CONFIG },
  {
    id: 'curl', label: 'REST', filename: 'terminal',
    code: `export BRAIN_KEY="brain_YOUR_API_KEY"

curl -X POST https://brain.inite.ai/v1/ingest/fact \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "entityRef": { "vertical": "rent", "id": "cust_42" },
    "predicate": "complained_about",
    "object": "late maintenance",
    "userId": "user_42",
    "validFrom": "2026-09-01T10:00:00Z",
    "source": { "vertical": "rent", "messageId": "msg_1" }
  }'

curl -X POST https://brain.inite.ai/v1/search \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "maintenance issues", "userId": "user_42", "limit": 5 }'`,
  },
  {
    id: 'sdk', label: 'TypeScript', filename: 'Node.js · native fetch',
    code: `const headers = {
  Authorization: \`Bearer \${process.env.BRAIN_KEY}\`,
  'Content-Type': 'application/json',
}

const write = await fetch('https://brain.inite.ai/v1/ingest/fact', {
  method: 'POST', headers,
  body: JSON.stringify({
    entityRef: { vertical: 'rent', id: 'cust_42' },
    predicate: 'complained_about',
    object: 'late maintenance',
    validFrom: '2026-09-01T10:00:00Z',
    userId: 'user_42',
    source: { vertical: 'rent', messageId: 'msg_1' },
  }),
})
if (!write.ok) throw new Error(\`Ingest failed: \${write.status}\`)

const response = await fetch('https://brain.inite.ai/v1/search', {
  method: 'POST', headers,
  body: JSON.stringify({
    query: 'maintenance issues', userId: 'user_42', limit: 5,
  }),
})
if (!response.ok) throw new Error(\`Search failed: \${response.status}\`)
const hits = await response.json()`,
  },
] as const
