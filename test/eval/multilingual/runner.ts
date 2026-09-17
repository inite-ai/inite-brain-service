/**
 * Tier-0 multilingual matrix — LIVE.
 *
 * The multilingual roadmap names Tier 0 "the measurable gate that must
 * exist before any behaviour flip", and until now it did not: the matrix,
 * the metrics and the report were built and complete, but the only model
 * they ever ran against was StubModel, which derives its predictions from
 * each case's own gold. Eleven MULTILINGUAL_* lanes have been parked
 * behind a gate that had never been opened on the real system.
 *
 * This runs the same 28-case grid against a running brain and prints the
 * same report, so the baseline and every later flag flip are read off one
 * instrument.
 *
 *   BRAIN_BASE_URL=http://localhost:3112 \
 *   BRAIN_API_KEY=... BRAIN_COMPANY_ID=... \
 *   npm run eval:multilingual
 *
 * Optional: ML_REPORT_DIR to write the serialized report, ML_RUN_ID to
 * label the per-case user scopes (defaults to a timestamp, so two
 * concurrent runs against one tenant never share a scope).
 *
 * HONEST COVERAGE. Cases whose gold this live path cannot produce
 * WITHOUT inventing a mapping are reported as skipped, by id and reason,
 * and their metric cells come back as no-data rather than as a number.
 * The `conflict` and `lane` label blocks are in that category: mapping
 * the resolver's own outcome vocabulary onto the matrix's is a judgment
 * nobody has made yet, and making it up inside a runner would produce a
 * cell that looks measured and is not.
 */
import { multilingualMatrix } from '../../../src/eval/scenarios/multilingual.scenarios';
import { HttpBrainClient } from '../http-brain-client';
import { MultilingualMatrixRunner } from './matrix-runner';
import { MultilingualReporter } from './matrix-reporter';
import { PrefetchedModel, collectLivePredictions, liveCoverage } from './live-model';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`[multilingual] ${name} is required`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const baseUrl = process.env.BRAIN_BASE_URL ?? 'http://localhost:3112';
  const apiKey = required('BRAIN_API_KEY');
  const runId = process.env.ML_RUN_ID ?? `ml${Date.now().toString(36)}`;
  const client = new HttpBrainClient({ baseUrl, apiKey });

  const { covered, skipped } = liveCoverage(multilingualMatrix);
  console.log(
    `[multilingual] ${covered.length}/${multilingualMatrix.length} case(s) drivable live, run ${runId}`,
  );
  for (const s of skipped) console.log(`[multilingual] skipped ${s.id}: ${s.reason}`);

  const predictions = await collectLivePredictions(covered, {
    client,
    runId,
    onProgress: (line) => console.log(line),
  });

  const report = new MultilingualMatrixRunner().run(covered, new PrefetchedModel(predictions));
  const reporter = new MultilingualReporter();
  console.log('');
  console.log(reporter.render(report));

  const dir = process.env.ML_REPORT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `multilingual-${runId}.json`);
    writeFileSync(
      path,
      JSON.stringify({ ...reporter.serialize(report), runId, skipped, baseUrl }, null, 2),
    );
    console.log(`\n[multilingual] report: ${path}`);
  }
}

void main().catch((e: unknown) => {
  console.error(`[multilingual] failed: ${(e as Error).message}`);
  process.exit(1);
});
