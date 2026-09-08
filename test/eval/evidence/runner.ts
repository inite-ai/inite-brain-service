/**
 * Evidence battery runner — drives the whole evidence plane through the
 * real wire, mirroring the memory-fitness / state-transitions /
 * domain-packs / code-memory siblings:
 *
 *   REST  GET  /v1/admin/config                          (phase 0 gates)
 *   REST  POST /v1/admin/packs                           (fixture packs)
 *   REST  POST /v1/ingest/evidence-blob                  (bytes)
 *   REST  POST /v1/ingest/evidence-asset                 (fragments)
 *   REST  POST /v1/admin/maintenance/evidence/dispatch   (processing)
 *   REST  GET  /v1/evidence/{id}/raw | raw-url | redeem  (gateway)
 *   REST  POST|GET|DELETE /v1/evidence/.../grants        (sharing)
 *   REST  POST /v1/users/{id}/forget                     (erasure)
 *
 * Scoring is fully mechanical — status codes, sha256 comparisons and
 * documented response counters. Unlike the four siblings this battery
 * spends NOTHING on models: no path it exercises calls one, so a stand
 * booted with a placeholder OPENAI_API_KEY scores every dimension. The
 * single exception (E4's serving leg) is opt-in behind EVEV_ALLOW_SYNTHESIZE
 * and skipped by default.
 *
 * Run: pnpm eval:evidence   (see README.md for stand flags)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './checks';
import { ALL_CHECKS, CHECKS_AFTER_FORGET, CHECKS_BEFORE_FORGET } from './checks';
import type { Ctx } from './context';
import { primaryDocument, sharedDocument, soleDocument, spareDocument } from './fixtures';
import {
  appendFragment,
  buildGates,
  mintAsset,
  mintToken,
  runForget,
  setupTrail,
  shareWith,
} from './setup';
import type { CheckResult, Dimension, Scorecard, Stand, Tally } from './types';
import { DIMENSION_LABELS } from './types';
import type { Wire } from './wire';
import { str } from './wire';

interface Config {
  wire: Wire;
  wireB: Wire | null;
  runId: string;
  maxWaitSeconds: number;
  allowSynthesize: boolean;
  reportDir: string;
}

const USAGE = [
  'evidence: BRAIN_BASE_URL is not set — nothing to run against.',
  'This battery drives a LIVE brain stand over REST and is intentionally never run in CI.',
  '',
  'Required env:',
  '  BRAIN_BASE_URL   e.g. http://localhost:3055  (BRAIN_URL also accepted)',
  '  BRAIN_API_KEY    tenant M2M key with brain:read + brain:write + brain:admin',
  '  BRAIN_COMPANY_ID tenant id — use a FRESH tenant per run (see README.md)',
  '',
  'Optional env: EVEV_RUN_ID (default time-derived; every user handle, pack id and',
  'byte payload is salted with it, so re-runs never collide), EVEV_TENANT_B_ID +',
  'EVEV_TENANT_B_KEY (a second tenant — without it the two cross-tenant checks are',
  'SKIPPED, never passed), EVEV_MAX_WAIT_S (default 90 — the ceiling on waiting out',
  'a signed-URL TTL), EVEV_ALLOW_SYNTHESIZE=1 (opt into the one model-spending',
  'check), EVEV_REPORT_DIR (default var/evidence).',
].join('\n');

function loadConfig(): Config {
  const baseUrl = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL;
  const apiKey = process.env.BRAIN_API_KEY;
  const companyId = process.env.BRAIN_COMPANY_ID;
  if (baseUrl === undefined || baseUrl === '') {
    console.error(USAGE);
    process.exit(1);
  }
  if (apiKey === undefined || apiKey === '') {
    console.error('evidence: BRAIN_API_KEY is not set.');
    process.exit(1);
  }
  if (companyId === undefined || companyId === '') {
    console.error('evidence: BRAIN_COMPANY_ID is not set.');
    process.exit(1);
  }
  const base = baseUrl.replace(/\/$/, '');
  const tenantBId = process.env.EVEV_TENANT_B_ID;
  const tenantBKey = process.env.EVEV_TENANT_B_KEY;
  const wait = Number(process.env.EVEV_MAX_WAIT_S ?? '90');
  return {
    wire: { baseUrl: base, apiKey, companyId },
    wireB:
      tenantBId && tenantBKey ? { baseUrl: base, apiKey: tenantBKey, companyId: tenantBId } : null,
    runId: process.env.EVEV_RUN_ID ?? `ev${Date.now().toString(36)}`,
    maxWaitSeconds: Number.isFinite(wait) && wait > 0 ? wait : 90,
    allowSynthesize: process.env.EVEV_ALLOW_SYNTHESIZE === '1',
    reportDir: process.env.EVEV_REPORT_DIR ?? join('var', 'evidence'),
  };
}

const emptyStand = (): Stand => ({
  primary: null,
  primaryUploadStatus: 0,
  primaryQuarantineStatus: null,
  spare: null,
  sole: null,
  shared: null,
  tenantB: null,
  firstDispatch: null,
  agingToken: null,
  agingTokenExpiresAt: 0,
  spareToken: null,
  forget: null,
});

/** Phase 1 — mint every fixture asset the checks read. */
async function mintFixtures(ctx: Ctx): Promise<void> {
  const owner = { userId: ctx.ownerUserId, runId: ctx.runId };
  const subject = { userId: ctx.forgetUserId, runId: ctx.runId };

  const primary = await mintAsset(ctx.wire, primaryDocument(ctx.runId), owner);
  ctx.stand.primary = primary.asset;
  ctx.stand.primaryUploadStatus = primary.res.status;
  ctx.stand.primaryQuarantineStatus = str(primary.res.json, 'quarantineStatus');
  if (primary.asset) {
    primary.asset.fragmentId = await appendFragment(ctx.wire, primary.asset, owner);
    const token = await mintToken(ctx.wire, primary.asset.assetId);
    ctx.stand.agingToken = token?.token ?? null;
    ctx.stand.agingTokenExpiresAt = token?.expiresAt ?? 0;
  }

  const spare = await mintAsset(ctx.wire, spareDocument(ctx.runId), owner);
  ctx.stand.spare = spare.asset;
  if (spare.asset) {
    spare.asset.fragmentId = await appendFragment(ctx.wire, spare.asset, owner);
    ctx.stand.spareToken = (await mintToken(ctx.wire, spare.asset.assetId))?.token ?? null;
  }

  const sole = await mintAsset(ctx.wire, soleDocument(ctx.runId), subject);
  ctx.stand.sole = sole.asset;
  if (sole.asset) sole.asset.fragmentId = await appendFragment(ctx.wire, sole.asset, subject);

  const shared = await mintAsset(ctx.wire, sharedDocument(ctx.runId), subject);
  ctx.stand.shared = shared.asset;
  if (shared.asset) {
    shared.asset.fragmentId = await appendFragment(ctx.wire, shared.asset, subject);
    await shareWith(ctx.wire, shared.asset.assetId, ctx.survivorUserId);
  }

  if (ctx.wireB !== null) {
    await buildTenantB(ctx);
  }
  console.error(`[setup] ${JSON.stringify(setupTrail(ctx).assets)}`);
}

/**
 * Tenant B holds BYTE-IDENTICAL content to tenant A's primary asset. It
 * needs its own probe-pack install because modality consent is a
 * per-tenant row — without it B's raw read would 404 for the wrong
 * reason and the co-tenant survival check would read as a failure.
 */
async function buildTenantB(ctx: Ctx): Promise<void> {
  if (ctx.wireB === null) return;
  await buildGates({ wire: ctx.wireB, wireB: null, runId: ctx.runId });
  const twin = await mintAsset(ctx.wireB, primaryDocument(ctx.runId), {
    userId: ctx.ownerUserId,
    runId: ctx.runId,
  });
  ctx.stand.tenantB = twin.asset;
}

async function runGroup(ctx: Ctx, group: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of group) {
    const started = Date.now();
    let verdict;
    try {
      verdict = await check.run(ctx);
    } catch (err) {
      verdict = { status: 'fail' as const, detail: `runner error: ${String(err)}` };
    }
    const { run: _run, ...def } = check;
    const result: CheckResult = {
      ...def,
      status: verdict.status,
      detail: verdict.detail,
      latencyMs: Date.now() - started,
    };
    results.push(result);
    const note =
      verdict.status === 'fail' && check.expectedUnknown !== undefined
        ? ' (gap-gated finding)'
        : '';
    console.error(
      `[check] ${check.id} ${verdict.status}${note} ${result.latencyMs}ms — ${verdict.detail}`,
    );
  }
  return results;
}

const emptyTally = (): Tally => ({ pass: 0, fail: 0, skipped: 0 });

function buildScorecard(
  cfg: Config,
  ctx: Ctx,
  span: { startedAt: string; results: CheckResult[] },
): Scorecard {
  const dimensions = Object.fromEntries(
    (Object.keys(DIMENSION_LABELS) as Dimension[]).map((d) => [d, emptyTally()]),
  ) as Record<Dimension, Tally>;
  const overall = { pass: 0, fail: 0, skipped: 0, total: 0, failedExpectedUnknown: 0 };
  for (const r of span.results) {
    dimensions[r.dimension][r.status] += 1;
    overall[r.status] += 1;
    overall.total += 1;
    if (r.status === 'fail' && r.expectedUnknown !== undefined) overall.failedExpectedUnknown += 1;
  }
  return {
    runId: cfg.runId,
    baseUrl: cfg.wire.baseUrl,
    companyId: cfg.wire.companyId,
    ownerUserId: ctx.ownerUserId,
    startedAt: span.startedAt,
    finishedAt: new Date().toISOString(),
    setup: setupTrail(ctx),
    dimensions,
    overall,
    gapGatedChecks: ALL_CHECKS.filter((c) => c.expectedUnknown !== undefined).map((c) => c.id),
    results: span.results,
  };
}

function printScorecard(card: Scorecard): void {
  console.log('');
  console.log(`evidence scorecard — run ${card.runId} (tenant ${card.companyId})`);
  console.log('─'.repeat(72));
  for (const d of Object.keys(DIMENSION_LABELS) as Dimension[]) {
    const t = card.dimensions[d];
    console.log(
      `${d}  ${DIMENSION_LABELS[d].padEnd(20)} pass ${t.pass}  fail ${t.fail}` +
        (t.skipped > 0 ? `  skipped ${t.skipped}` : ''),
    );
  }
  console.log('─'.repeat(72));
  const scored = card.overall.pass + card.overall.fail;
  const pct = scored === 0 ? 0 : Math.round((card.overall.pass / scored) * 1000) / 10;
  console.log(
    `overall: ${card.overall.pass}/${scored} scored (${pct}%), ` +
      `${card.overall.skipped} skipped of ${card.overall.total}` +
      (card.overall.failedExpectedUnknown > 0
        ? ` — ${card.overall.failedExpectedUnknown} fail(s) are gap-gated findings, not regressions`
        : ''),
  );
  console.log(
    `gap-gated (expectedUnknown): ${card.gapGatedChecks.join(', ')} — a skip or fail there is ` +
      'the recorded gap; a pass is the measured signal the capability landed.',
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = new Date().toISOString();
  console.error(
    `evidence: run ${cfg.runId} against ${cfg.wire.baseUrl} (tenant ${cfg.wire.companyId})`,
  );

  const gates = await buildGates({ wire: cfg.wire, wireB: cfg.wireB, runId: cfg.runId });
  console.error(
    `[setup] probe pack ${gates.packId ?? `NOT INSTALLED (${gates.packError ?? '?'})`}; ` +
      `orphan-gc route ${gates.orphanGcRoute.present ? 'present' : `absent (${gates.orphanGcRoute.status})`}`,
  );

  const ctx: Ctx = {
    wire: cfg.wire,
    wireB: cfg.wireB,
    runId: cfg.runId,
    // Run-scoped identities (the #456 hermeticity doctrine): a fixed
    // default owner would inherit the previous run's grants and assets on
    // the same tenant, and the erasure phase would then destroy them.
    ownerUserId: `evev-owner-${cfg.runId}`,
    forgetUserId: `evev-subject-${cfg.runId}`,
    survivorUserId: `evev-keeper-${cfg.runId}`,
    maxWaitSeconds: cfg.maxWaitSeconds,
    allowSynthesize: cfg.allowSynthesize,
    gates,
    stand: emptyStand(),
  };

  await mintFixtures(ctx);
  const results = await runGroup(ctx, CHECKS_BEFORE_FORGET);
  ctx.stand.forget = await runForget(ctx);
  console.error(`[forget] ${ctx.forgetUserId} → HTTP ${ctx.stand.forget.status}`);
  results.push(...(await runGroup(ctx, CHECKS_AFTER_FORGET)));

  const card = buildScorecard(cfg, ctx, { startedAt, results });
  mkdirSync(cfg.reportDir, { recursive: true });
  const reportPath = join(cfg.reportDir, `evidence-${cfg.runId}.json`);
  writeFileSync(reportPath, `${JSON.stringify(card, null, 2)}\n`);
  printScorecard(card);
  console.log(`report: ${reportPath}`);
}

// A failing CHECK is a finding, not a runner error — the battery reports,
// it does not gate CI, so the process still exits 0. Only an unexpected
// throw (a battery bug) sets a non-zero code.
void main().catch((err: unknown) => {
  console.error('evidence: runner failed:', err);
  process.exitCode = 1;
});
