/** Shared, copyable examples. Placeholder keys never grant access. */

/**
 * The headline MCP config is the REMOTE one.
 *
 * This used to show the stdio bridge — `npx -y @inite/brain-mcp` with a
 * `BRAIN_COMPANY_ID` — which is the fallback for harnesses that cannot
 * attach an Authorization header, not the path anyone should start on.
 * It also asked for a tenant id that the endpoint stopped needing: the
 * tenant comes from the credential, so a URL and a key is the whole
 * configuration.
 */
export const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    brain: {
      type: 'http',
      url: 'https://brain.inite.ai/mcp',
      headers: { Authorization: 'Bearer brain_YOUR_API_KEY' },
    },
  },
}, null, 2)

/** The stdio bridge, for harnesses that cannot send a header. */
export const MCP_STDIO_CONFIG = JSON.stringify({
  mcpServers: {
    brain: {
      command: 'npx',
      args: ['-y', '@inite/brain-mcp'],
      env: { BRAIN_API_KEY: 'brain_YOUR_API_KEY' },
    },
  },
}, null, 2)

/**
 * Order matters: the first write a reader sees should be the smallest
 * one that works. `/v1/ingest/mention` takes text and a user and does
 * the extraction; the typed `/v1/ingest/fact` path is the precision
 * route for callers that already have a structured claim, and it earns
 * its own tab rather than being the first hurdle.
 */
export const QUICKSTART_EXAMPLES = [
  { id: 'mcp', label: 'MCP', filename: '.mcp.json · .cursor/mcp.json · any remote client', code: MCP_CONFIG },
  {
    id: 'curl', label: 'REST', filename: 'terminal',
    code: `export BRAIN_KEY="brain_YOUR_API_KEY"

curl -X POST https://brain.inite.ai/v1/ingest/mention \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "Maria moved to Berlin in June and prefers morning appointments.",
    "userId": "user_42"
  }'

curl -X POST https://brain.inite.ai/v1/search \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "where does Maria live", "userId": "user_42", "limit": 5 }'`,
  },
  {
    id: 'typed', label: 'REST · typed', filename: 'terminal',
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

const write = await fetch('https://brain.inite.ai/v1/ingest/mention', {
  method: 'POST', headers,
  body: JSON.stringify({
    text: 'Maria moved to Berlin in June and prefers morning appointments.',
    userId: 'user_42',
  }),
})
if (!write.ok) throw new Error(\`Ingest failed: \${write.status}\`)

const response = await fetch('https://brain.inite.ai/v1/search', {
  method: 'POST', headers,
  body: JSON.stringify({
    query: 'where does Maria live', userId: 'user_42', limit: 5,
  }),
})
if (!response.ok) throw new Error(\`Search failed: \${response.status}\`)
const hits = await response.json()`,
  },
  {
    id: 'brain-sdk', label: 'SDK', filename: 'npm i @inite/brain',
    code: `import { createBrain, brainTools } from '@inite/brain'

const brain = createBrain({
  apiKey: process.env.BRAIN_KEY!,
  userId: 'user_42', // threaded onto every call, reads and writes alike
})

await brain.remember('Maria moved to Berlin in June and prefers morning appointments.')

const { answer, citations } = await brain.answer('where does Maria live')

// Or hand the same memory to an agent framework — this object is what
// the Vercel AI SDK's \`tools:\` map takes directly.
// await generateText({ model, tools: brainTools(brain), prompt })`,
  },
] as const
