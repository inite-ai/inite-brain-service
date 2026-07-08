#!/usr/bin/env ts-node
/**
 * Code-memory Phase 2b — anchor re-validation sweep CLI.
 * (docs/roadmap/code-memory-domain.md)
 *
 *   BRAIN_API_KEY=... pnpm code-memory:validate-anchors -- \
 *     --brain-url https://brain.inite.ai [--dry-run]
 *
 * Runs where the code lives. Lists the tenant's code anchors from brain, checks
 * each against the current working tree (symbol still present? file still
 * there?), re-anchors moved/renamed symbols and invalidates gone ones, then
 * POSTs the verdicts. Only anchor strings cross the wire — never source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAnchorVerdicts,
  heuristicChoose,
} from '../src/code-memory/anchor/sweep';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const brainUrl = arg('brain-url', process.env.BRAIN_URL);
  const brainKey = process.env.BRAIN_API_KEY;
  const dryRun = process.argv.includes('--dry-run');
  if (!brainUrl || !brainKey) {
    throw new Error('--brain-url and BRAIN_API_KEY are required');
  }
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${brainKey}`,
  };

  const listed = await fetch(`${brainUrl}/v1/admin/code-memory/anchors`, {
    headers,
  });
  if (!listed.ok) throw new Error(`list anchors failed: ${listed.status}`);
  const { anchors } = (await listed.json()) as {
    anchors: Array<{ anchor: string }>;
  };
  console.error(`[anchors] ${anchors.length} anchor(s) to check`);

  // --force bypasses the blast-radius guard for a confirmed mass removal.
  const force = process.argv.includes('--force');
  const verdicts = buildAnchorVerdicts({
    anchors: anchors.map((a) => a.anchor),
    readFile: (p) => {
      try {
        return readFileSync(join(process.cwd(), p), 'utf8');
      } catch {
        return null;
      }
    },
    choose: heuristicChoose,
    ...(force ? { maxInvalidateRatio: 1 } : {}),
  });
  const actionable = verdicts.filter((v) => v.action !== 'ok');
  console.error(
    `[anchors] ${actionable.length} actionable: ` +
      JSON.stringify(actionable),
  );

  if (dryRun || actionable.length === 0) {
    console.error('[anchors] dry-run / nothing to apply');
    return;
  }
  const applied = await fetch(
    `${brainUrl}/v1/admin/code-memory/anchors/apply`,
    { method: 'POST', headers, body: JSON.stringify({ verdicts: actionable }) },
  );
  if (!applied.ok) throw new Error(`apply failed: ${applied.status}`);
  console.error(`[anchors] applied: ${JSON.stringify(await applied.json())}`);
}

main().catch((e) => {
  console.error(`[anchors] fatal: ${(e as Error).message}`);
  process.exit(1);
});
