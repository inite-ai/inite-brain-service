/**
 * backfill-lang-attribution — re-stamp existing knowledge_fact rows with
 * confidence-aware language attribution (multilingual Tier 1, migration
 * 0100), under the CURRENT detector version.
 *
 * WHY a script, not a migration: migration 0100 is deliberately additive +
 * data-mutation-free (option<...> columns, no backfill at migrate time —
 * the 0098/0099 posture). Re-labelling the historical corpus is a separate,
 * EXPLICIT, admin-triggered operation so a schema apply never rewrites data.
 *
 * WHY a script, not an admin endpoint (the scope choice, per the task): a
 * full POST /v1/admin/... surface (controller + DTO + auth + job + tests)
 * would balloon this Tier-1 change. This script is the bounded equivalent —
 * same effect (flag-gated, admin-run, never auto-run), reviewed in one file.
 *
 * TODO(multilingual Tier 2): promote to an admin endpoint / background job
 * with per-tenant progress + resumable cursor persistence, and extend to
 * stamp `sourceLang` by joining each fact's grounding episode(s)
 * (source.episodeIds → episode.lang). This script stamps DETECTED labels
 * only (lang / langConfidence / langSource='detected' / detectorVersion);
 * it does NOT compute inheritance, because the source-turn language is not
 * on the fact row.
 *
 * FLAG-GATED: refuses to run unless MULTILINGUAL_LANG_ATTRIBUTION is on (so
 * a backfill can't precede the feature it supports) — override with --force
 * only when you know the flag will be enabled next.
 *
 * IDEMPOTENT: re-running re-derives the same labels from the same objects
 * under the same detector version, so a second pass is a no-op in effect.
 *
 * Usage:
 *   MULTILINGUAL_LANG_ATTRIBUTION=1 npx tsx scripts/backfill-lang-attribution.ts \
 *     --url http://127.0.0.1:8000 --user root --pass root \
 *     --ns brain --tenant <companyId> [--batch 500] [--dry-run] [--force]
 *
 * The password may come from SURREAL_PASS instead of argv (argv leaks into
 * `ps` output on shared stands).
 *
 * Exit codes: 0 = completed (or dry-run); 1 = error / refused (flag off
 * without --force).
 */
import { Surreal, StringRecordId } from 'surrealdb';
import { detectLanguage, DETECTOR_VERSION } from '../src/ai/locale/language-detector';
import { envFlagEnabled } from '../src/common/env-validation';

interface Args {
  url: string;
  user: string;
  pass: string;
  ns: string;
  tenant: string;
  batch: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const url = get('url') ?? 'http://127.0.0.1:8000';
  const user = get('user') ?? 'root';
  const pass = get('pass') ?? process.env.SURREAL_PASS ?? 'root';
  const ns = get('ns') ?? 'brain';
  const tenant = get('tenant');
  if (!tenant) {
    console.error('backfill-lang-attribution: --tenant <companyId> is required');
    process.exit(1);
  }
  const batch = Number(get('batch') ?? '500');
  return {
    url,
    user,
    pass,
    ns,
    tenant,
    batch: Number.isFinite(batch) && batch > 0 ? batch : 500,
    dryRun: has('dry-run'),
    force: has('force'),
  };
}

interface FactRow {
  id: unknown;
  object: string;
}

/** One detected-attribution stamp for a fact (sourceLang deferred — see TODO). */
function attributionFor(object: string): {
  lang: string | null;
  langConfidence: number;
  langSource: 'detected';
  detectorVersion: string;
} {
  // Force attribution-aware detection regardless of the ambient flag: the
  // backfill IS the attribution write, so a short/stopword-less object must
  // resolve to `und` (null lang), never the legacy `en`.
  const det = detectLanguage(object, true);
  return {
    lang: det.language === 'und' ? null : det.language,
    langConfidence: det.confidence,
    langSource: 'detected',
    detectorVersion: det.detectorVersion,
  };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));

  if (!a.force && !envFlagEnabled(process.env.MULTILINGUAL_LANG_ATTRIBUTION)) {
    console.error(
      'backfill-lang-attribution: refusing — MULTILINGUAL_LANG_ATTRIBUTION is off. ' +
        'Enable the flag (recommended) or pass --force to backfill ahead of it.',
    );
    process.exit(1);
  }

  const db = new Surreal();
  await db.connect(a.url);
  await db.signin({ username: a.user, password: a.pass });
  await db.use({ namespace: a.ns, database: `co_${a.tenant}` });

  console.info(
    `backfill-lang-attribution: tenant=${a.tenant} detector=${DETECTOR_VERSION} ` +
      `batch=${a.batch}${a.dryRun ? ' (dry-run)' : ''}`,
  );

  let cursor: string | null = null;
  let scanned = 0;
  let stamped = 0;
  for (;;) {
    // Keyset pagination over the record id — stable under concurrent writes
    // and index-friendly (no OFFSET blow-up on large corpora).
    const [rows] = await db.query<[FactRow[]]>(
      `SELECT id, object FROM knowledge_fact
        ${cursor ? 'WHERE id > $cursor' : ''}
        ORDER BY id ASC LIMIT $batch`,
      { cursor: cursor ? new StringRecordId(cursor) : undefined, batch: a.batch },
    );
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      scanned += 1;
      if (typeof r.object !== 'string' || r.object.length === 0) continue;
      const attr = attributionFor(r.object);
      if (!a.dryRun) {
        await db.query(
          `UPDATE $id SET
             lang = $lang,
             langConfidence = $langConfidence,
             langSource = $langSource,
             detectorVersion = $detectorVersion`,
          {
            id: new StringRecordId(String(r.id)),
            lang: attr.lang ?? undefined,
            langConfidence: attr.langConfidence,
            langSource: attr.langSource,
            detectorVersion: attr.detectorVersion,
          },
        );
      }
      stamped += 1;
    }
    cursor = String(rows[rows.length - 1]!.id);
    console.info(`  … scanned ${scanned}, stamped ${stamped}`);
  }

  console.info(
    `backfill-lang-attribution: done — scanned ${scanned}, ` +
      `${a.dryRun ? 'would stamp' : 'stamped'} ${stamped}.`,
  );
  await db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`backfill-lang-attribution: failed — ${(e as Error).message}`);
  process.exit(1);
});
