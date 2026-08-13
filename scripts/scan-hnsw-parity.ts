/**
 * scan-hnsw-parity — read-only recall check of the coverage-scan HNSW
 * legs against the exact brute oracle, per tenant (V11 §5 enable gate:
 * recall@cap ≥ 0.98 at the default knobs before flipping
 * coverageScanMode='hnsw' for a tenant).
 *
 * Probe vectors are sampled from the table's own stored embeddings —
 * no embedder dependency, zero LLM cost — which measures exactly what
 * the index degrades: approximate nearest-neighbor recall under the
 * lanes' WHERE gates (SurrealDB applies gates AFTER the KNN walk).
 *
 * Usage:
 *   npx tsx scripts/scan-hnsw-parity.ts \
 *     --url http://127.0.0.1:8000 --user root --pass root \
 *     --ns brain --tenant <companyId> [--lane a|b|both] \
 *     [--probes 24] [--ef 0 (=clamp)] [--overfetch 4] \
 *     [--derived-version <pin>] [--grid]
 *
 * The password may come from SURREAL_PASS instead of argv (argv leaks
 * into `ps` output on shared stands).
 *
 * Exit codes (audit 2026-08-13 P1): 0 = every lane PASS; 1 = any lane
 * FAIL; 2 = no FAIL but a lane SKIPPED (no embedded rows, or fewer
 * than --min-probes sampled). A rollout script must only flip
 * coverageScanMode='hnsw' on exit 0 — a skip is NOT a pass.
 *
 * Lane A = mention-scan over episode_segment (k=400, pii+user gates).
 * Lane B = query_arc over knowledge_fact (k=200, atomic+status+world
 * gates, lane overfetch ×2). Both replicate the tenant-global caller
 * (no read_pii scope, no userId) — the production shape of eval reads.
 */
import { Surreal } from 'surrealdb';

interface Args {
  url: string;
  user: string;
  pass: string;
  ns: string;
  tenant: string;
  lane: 'a' | 'b' | 'both';
  probes: number;
  minProbes: number;
  ef: number;
  overfetch: number;
  derivedVersion?: string;
  grid: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const die = (msg: string): never => {
    console.error(msg);
    process.exit(1);
  };
  const posInt = (name: string, dflt: string): number => {
    const n = parseInt(get(name, dflt)!, 10);
    if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer`);
    return n;
  };
  const tenant = get('tenant');
  if (!tenant) die('required: --tenant <companyId>');
  const lane = get('lane', 'both')!;
  if (lane !== 'a' && lane !== 'b' && lane !== 'both') {
    die(`--lane must be a|b|both, got '${lane}'`);
  }
  const probes = posInt('probes', '24');
  const minProbes = posInt('min-probes', '8');
  if (probes < 1) die('--probes must be >= 1');
  const overfetch = posInt('overfetch', '4');
  if (overfetch < 1) die('--overfetch must be >= 1');
  return {
    url: get('url', 'http://127.0.0.1:8000')!,
    user: get('user', 'root')!,
    pass: get('pass') ?? process.env.SURREAL_PASS ?? 'root',
    ns: get('ns', 'brain')!,
    tenant: tenant!,
    lane: lane as Args['lane'],
    probes,
    minProbes,
    ef: posInt('ef', '0'),
    overfetch,
    derivedVersion: get('derived-version'),
    grid: argv.includes('--grid'),
  };
}

interface LaneSpec {
  name: string;
  table: string;
  k: number;
  gates: string;
  params: Record<string, unknown>;
}

function lanes(a: Args): LaneSpec[] {
  const out: LaneSpec[] = [];
  if (a.lane !== 'b') {
    out.push({
      name: 'A mention-scan (episode_segment)',
      table: 'episode_segment',
      k: 400,
      gates: 'AND piiClass IS NONE AND userId IS NONE',
      params: {},
    });
  }
  if (a.lane !== 'a') {
    const worldGate = a.derivedVersion
      ? 'AND derivedVersion = $derivedVersion'
      : 'AND derivedVersion IS NONE';
    out.push({
      name: 'B query_arc (knowledge_fact)',
      table: 'knowledge_fact',
      k: 200,
      gates: `AND !(source.recorder = $insightRecorder
             OR string::starts_with(predicate, 'summary_'))
           AND retractedAt IS NONE
           AND status = 'active'
           AND piiClass IS NONE AND userId IS NONE ${worldGate}`,
      params: {
        insightRecorder: 'aggregate-composer-v1',
        ...(a.derivedVersion ? { derivedVersion: a.derivedVersion } : {}),
      },
    });
  }
  return out;
}

async function ids(
  db: Surreal,
  sql: string,
  params: Record<string, unknown>,
): Promise<string[]> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(sql, params);
  return (rows ?? []).map((r) => String(r.id));
}

type LaneVerdict = 'PASS' | 'FAIL' | 'SKIP';

async function runLane(
  db: Surreal,
  lane: LaneSpec,
  a: Args,
  overfetch: number,
  ef: number,
): Promise<LaneVerdict> {
  const [probeRows] = await db.query<[Array<{ id: unknown; embedding: number[] }>]>(
    `SELECT id, embedding FROM ${lane.table}
      WHERE embedding != NONE ORDER BY rand() LIMIT $n`,
    { n: a.probes },
  );
  if (!probeRows || probeRows.length < a.minProbes) {
    console.log(
      `  ${lane.name}: ${probeRows?.length ?? 0} embedded rows ` +
        `(< --min-probes ${a.minProbes}) — SKIP`,
    );
    return 'SKIP';
  }
  const kOver = Math.min(lane.k * overfetch, 4000);
  const effEf = Math.max(ef, kOver);
  const per: Array<{ probe: string; recall: number; jaccard: number }> = [];
  for (const probe of probeRows) {
    const shared = { q: probe.embedding, k: lane.k, ...lane.params };
    const exact = await ids(
      db,
      `SELECT id FROM ${lane.table}
        WHERE embedding != NONE ${lane.gates}
        ORDER BY vector::similarity::cosine(embedding, $q) DESC LIMIT $k`,
      shared,
    );
    // vector::distance::knn() reuses the walk's distance — projecting
    // a fresh cosine next to <|k,ef|> drops the planner off the
    // KnnScan (measured 15× slower + an OOM-kill on 3.1.5).
    const approx = await ids(
      db,
      `SELECT id, vector::distance::knn() AS knnDist
         FROM ${lane.table}
        WHERE embedding <|${kOver},${effEf}|> $q ${lane.gates}
        ORDER BY knnDist ASC LIMIT $k`,
      shared,
    );
    const exactSet = new Set(exact);
    const approxSet = new Set(approx);
    const hit = exact.filter((id) => approxSet.has(id)).length;
    const union = new Set([...exactSet, ...approxSet]).size;
    per.push({
      probe: String(probe.id),
      recall: exact.length > 0 ? hit / exact.length : 1,
      jaccard: union > 0 ? hit / union : 1,
    });
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const recall = mean(per.map((p) => p.recall));
  const jaccard = mean(per.map((p) => p.jaccard));
  const verdict: LaneVerdict = recall >= 0.98 ? 'PASS' : 'FAIL';
  console.log(
    `  ${lane.name}: recall@k=${recall.toFixed(4)} jaccard=${jaccard.toFixed(4)} ` +
      `(kOver=${kOver}, ef=${effEf}, probes=${per.length}) → ${verdict} (gate ≥0.98)`,
  );
  const worst = [...per].sort((x, y) => x.recall - y.recall).slice(0, 5);
  for (const w of worst) {
    if (w.recall < 1) {
      console.log(`    worst: ${w.probe} recall=${w.recall.toFixed(4)}`);
    }
  }
  return verdict;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const db = new Surreal();
  await db.connect(a.url);
  await db.signin({ username: a.user, password: a.pass });
  await db.use({ namespace: a.ns, database: `co_${a.tenant}` });
  console.log(`tenant ${a.tenant} (db co_${a.tenant})`);
  const sweeps = a.grid
    ? [
        { overfetch: 2, ef: 0 },
        { overfetch: 4, ef: 0 },
        { overfetch: 8, ef: 0 },
        { overfetch: 4, ef: 3200 },
      ]
    : [{ overfetch: a.overfetch, ef: a.ef }];
  const verdicts: LaneVerdict[] = [];
  for (const s of sweeps) {
    console.log(`sweep overfetch=${s.overfetch} ef=${s.ef || '(clamp)'}:`);
    for (const lane of lanes(a)) {
      // Lane B applies its own ×2 gate factor, as in query-arc.service.
      const overfetch =
        lane.table === 'knowledge_fact' ? s.overfetch * 2 : s.overfetch;
      verdicts.push(await runLane(db, lane, a, overfetch, s.ef));
    }
  }
  await db.close();
  // Machine-readable gate: FAIL anywhere → 1, else SKIP anywhere → 2.
  if (verdicts.includes('FAIL')) {
    console.log('verdict: FAIL');
    process.exit(1);
  }
  if (verdicts.includes('SKIP') || verdicts.length === 0) {
    console.log('verdict: SKIP (not a pass — do not enable hnsw on this)');
    process.exit(2);
  }
  console.log('verdict: PASS');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
