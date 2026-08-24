import { existsSync, readFileSync } from 'node:fs';

/**
 * Best-effort OPENAI_API_KEY loader for local dev / CI fallback.
 * Looks at process.env first, then a hard-coded list of sibling repos
 * that commonly carry a working key. Throws if nothing found.
 */
const FALLBACK_PATHS = [
  '/Users/mikefluff/Documents/initeai/.env',
  '/Users/mikefluff/Documents/figma/.env',
  '/Users/mikefluff/Documents/mikefluff-site/.env',
  '/Users/mikefluff/Documents/mcp-second-brain/.env',
];

export function loadOpenAiKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  for (const path of FALLBACK_PATHS) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    const m = content.match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) return m[1]!.replace(/^["']|["']$/g, '').trim();
  }
  throw new Error(
    'OPENAI_API_KEY not in env and no fallback .env found. Set it before running real e2e.',
  );
}
