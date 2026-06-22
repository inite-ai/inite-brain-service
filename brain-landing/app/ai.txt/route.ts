import { SITE_URL, GITHUB_URL, ORG } from '../../lib/seo'

export const dynamic = 'force-static'

/**
 * /ai.txt — concise key=value identity profile for AI crawlers. Companion
 * to /llms.txt (long-form) and /robots.txt (access policy).
 */
export function GET() {
  const body = `# ai.txt — AI identity profile for ${ORG.name}
# See also: /llms.txt (long-form), /robots.txt (access), /sitemap.xml

name=INITE Brain
tagline=Bitemporal knowledge graph for AI agents
type=SoftwareApplication/DeveloperApplication
description=${ORG.description}
url=${SITE_URL}
docs=${SITE_URL}/en/docs
repository=${GITHUB_URL}
license=AGPL-3.0
pricing=open-source self-host; managed endpoint available
surfaces=REST,MCP
stack=NestJS,SurrealDB,BGE-M3,OpenAI,Cohere
contact=${GITHUB_URL}/issues
preferred-citation=INITE Brain (${SITE_URL})
`

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
