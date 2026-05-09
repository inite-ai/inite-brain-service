#!/usr/bin/env ts-node
/**
 * Fetch a directory sample from the Wikidata Query Service and
 * emit it as a JsonDirectory fixture compatible with the eval
 * runner's loader.
 *
 *     pnpm directory:fetch:wikidata <template> <limit> [--out <file>]
 *
 * Templates are declared in test/eval/loaders/wikidata-mapper.ts.
 * Run with no args to print the list. Without --out, the JSON is
 * written to stdout — pipe to a file or jq.
 *
 *     pnpm directory:fetch:wikidata russian-writers 100 \
 *       --out test/eval/fixtures/wd-russian-writers-100.json
 *
 *     OPENAI_API_KEY=sk-... \
 *       BRAIN_DIRECTORY_JSON=test/eval/fixtures/wd-russian-writers-100.json \
 *       pnpm test:eval:json
 *
 * Wikidata SPARQL is free and key-less but rate-limited. The fetcher
 * sends a User-Agent identifying this tool (per Wikidata's policy)
 * and retries once on 429 / 5xx with exponential backoff.
 */
import { writeFileSync } from 'node:fs';
import {
  WIKIDATA_TEMPLATES,
  mapWikidataBindings,
  type WikidataBinding,
} from '../test/eval/loaders/wikidata-mapper';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT =
  'inite-brain-service eval/0.1 (https://github.com/inite/inite-brain-service; eval-fixture-fetcher)';

interface CliArgs {
  template: string;
  limit: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  if (argv.length < 2) return null;
  const [template, limitRaw, ...rest] = argv;
  const limit = parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out' && rest[i + 1]) {
      out = rest[i + 1];
      i++;
    }
  }
  return { template, limit, out };
}

function usage(): void {
  const known = Object.keys(WIKIDATA_TEMPLATES).join(', ');
  console.error('Usage: fetch-wikidata-directory.ts <template> <limit> [--out <file>]');
  console.error(`Known templates: ${known || '(none)'}`);
}

async function fetchSparql(query: string): Promise<WikidataBinding[]> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
      },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        results?: { bindings?: WikidataBinding[] };
      };
      return json.results?.bindings ?? [];
    }
    // Retry on 429 (rate limit) and 5xx; bail on 4xx (client error).
    if (res.status !== 429 && res.status < 500) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Wikidata SPARQL HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `Wikidata SPARQL HTTP ${res.status} after ${attempt} attempts`,
      );
    }
    // Exponential backoff: 2s, 4s.
    const delayMs = 2000 * attempt;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('unreachable');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(2);
  }
  const template = WIKIDATA_TEMPLATES[args.template];
  if (!template) {
    console.error(
      `unknown template '${args.template}'. Known: ${Object.keys(WIKIDATA_TEMPLATES).join(', ')}`,
    );
    process.exit(2);
  }

  const sparql = template.sparql.replace('$LIMIT', String(args.limit));
  process.stderr.write(
    `[fetch-wikidata] template=${args.template} limit=${args.limit}\n`,
  );

  const bindings = await fetchSparql(sparql);
  process.stderr.write(`[fetch-wikidata] received ${bindings.length} binding(s)\n`);

  const { directory, stats } = mapWikidataBindings(bindings, template);
  process.stderr.write(
    `[fetch-wikidata] mapped: ${stats.uniqueEntities} unique entities, ` +
      `${stats.skippedEntities} skipped, ${stats.emittedFacts} facts emitted\n`,
  );

  const out = JSON.stringify(directory, null, 2);
  if (args.out) {
    writeFileSync(args.out, out);
    process.stderr.write(`[fetch-wikidata] wrote ${out.length} bytes → ${args.out}\n`);
  } else {
    process.stdout.write(out + '\n');
  }
}

main().catch((err) => {
  console.error(`[fetch-wikidata] failed: ${(err as Error).message}`);
  process.exit(1);
});
