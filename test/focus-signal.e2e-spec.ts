/**
 * e2e — fovea focus-signal capture + admin fit/measure surface (Optics-1).
 *
 * Verifies the serving-neutral contract:
 *   - FOVEA_FOCUS_CAPTURE off → a /v1/synthesize writes NO focus_signal_sample
 *     row (guarded no-op) and the admin surface 404s.
 *   - FOVEA_FOCUS_CAPTURE on → a /v1/synthesize records exactly one sample,
 *     companyId-scoped, at the verdict decision point.
 *   - The admin fit endpoint persists a per-class CalibrationMap and the
 *     reliability endpoint returns the §3 ECE report.
 */
import { randomUUID } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

describe('Fovea Optics-1 — focus-signal capture + calibration surface', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  // Count captured samples. Optionally filter by stage — §4.2 added a
  // 'preanswer'-stage capture at the coverage-abstention gate, so a query that
  // reaches the verdict point in coverage mode now writes two samples (one per
  // stage). These verdict-point-capture tests count the 'verdict' stage
  // explicitly to stay pinned to the Optics-1 behaviour they assert;
  // stage='NONE' rows (pre-0095) read as verdict.
  const sampleCount = async (stage?: 'verdict' | 'preanswer'): Promise<number> =>
    surreal.withCompany(f.companyId, async (db) => {
      const where =
        stage === 'verdict'
          ? " WHERE stage = 'verdict' OR stage IS NONE"
          : stage
            ? ` WHERE stage = '${stage}'`
            : '';
      const [rows] = await db.query<[Array<{ sampleId: string }>]>(
        `SELECT sampleId FROM focus_signal_sample${where}`,
      );
      return Array.isArray(rows) ? rows.length : 0;
    });

  const runSynthesize = async (query: string): Promise<void> => {
    const searchRes = await f.http.post('/v1/search').set(auth()).send({ query, limit: 5 });
    const factId = searchRes.body.results[0]?.facts[0]?.factId;
    expect(factId).toBeTruthy();
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: `Answer [${factId}].`, citedFactIds: [factId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http.post('/v1/synthesize').set(auth()).send({ query, limit: 5 });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    delete process.env.FOVEA_FOCUS_CAPTURE;
    f = await createApp();
    surreal = f.app.get(SurrealService);
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'focus_tenant' },
        predicate: 'status',
        object: 'engineer',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      });
  });

  afterAll(async () => {
    delete process.env.FOVEA_FOCUS_CAPTURE;
    if (f) await f.close();
  });

  it('writes NO sample when the flag is off (serving-neutral)', async () => {
    delete process.env.FOVEA_FOCUS_CAPTURE;
    const before = await sampleCount();
    await runSynthesize('engineer');
    const after = await sampleCount();
    expect(after).toBe(before);
  });

  it('404s the admin surface when the master flag is off', async () => {
    delete process.env.FOVEA_FOCUS_CAPTURE;
    const rel = await f.http.get('/v1/admin/focus/reliability').set(auth());
    expect(rel.status).toBe(404);
    const fit = await f.http.post('/v1/admin/focus/fit').set(auth()).send({});
    expect(fit.status).toBe(404);
  });

  it('records exactly one companyId-scoped verdict-stage sample when the flag is on', async () => {
    process.env.FOVEA_FOCUS_CAPTURE = '1';
    const before = await sampleCount('verdict');
    await runSynthesize('engineer');
    const after = await sampleCount('verdict');
    expect(after).toBe(before + 1);

    const row = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            companyId: string;
            queryClass: string;
            verifierVerdict: string;
            correct: number | null;
          }>,
        ]
      >(
        'SELECT companyId, queryClass, verifierVerdict, correct, createdAt FROM focus_signal_sample ORDER BY createdAt DESC LIMIT 1',
      );
      return rows?.[0];
    });
    expect(row?.companyId).toBe(f.companyId);
    expect(typeof row?.queryClass).toBe('string');
    // Unlabeled at capture time — correctness is backfilled by the harness.
    expect(row?.correct == null).toBe(true);
  });

  it('fits a per-class CalibrationMap and returns an ECE report', async () => {
    process.env.FOVEA_FOCUS_CAPTURE = '1';
    // Seed ~40 labeled samples directly so the default class earns a map.
    await surreal.withCompany(f.companyId, async (db) => {
      for (let i = 0; i < 40; i++) {
        const x = (i + 0.5) / 40;
        await db.query(
          `CREATE focus_signal_sample CONTENT {
              companyId: $c, sampleId: $s, queryClass: 'default',
              topScore: $x, coverageScore: $x, retrievalGap: $x,
              verifierVerdict: 'none', rawConfidence: $r, correct: $correct
           }`,
          {
            c: f.companyId,
            s: randomUUID(),
            x,
            r: 0.65 * x,
            correct: x > 0.5 ? 1 : 0,
          },
        );
      }
    });

    const fit = await f.http.post('/v1/admin/focus/fit').set(auth()).send({});
    expect(fit.status).toBe(201);
    expect(fit.body.sampleCount).toBeGreaterThanOrEqual(40);
    expect(Array.isArray(fit.body.classes)).toBe(true);
    expect(fit.body.classes.some((c: { queryClass: string }) => c.queryClass === 'default')).toBe(
      true,
    );

    // A CalibrationMap row was persisted.
    const persisted = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ queryClass: string; thresholds: number[]; values: number[] }>]
      >('SELECT queryClass, thresholds, values FROM focus_calibration');
      return rows ?? [];
    });
    const def = persisted.find((r) => r.queryClass === 'default');
    expect(def).toBeDefined();
    expect(Array.isArray(def!.thresholds)).toBe(true);
    expect(def!.thresholds.length).toBe(def!.values.length);

    // §3 measurement returns a numeric ECE + diagram.
    const rel = await f.http.get('/v1/admin/focus/reliability').set(auth());
    expect(rel.status).toBe(200);
    expect(typeof rel.body.ece).toBe('number');
    expect(Array.isArray(rel.body.diagram)).toBe(true);
    expect(rel.body.sampleCount).toBeGreaterThanOrEqual(40);
  });

  it('backfills outcome labels by sampleId', async () => {
    process.env.FOVEA_FOCUS_CAPTURE = '1';
    // The one captured (unlabeled) sample from the flag-on test.
    const list = await f.http.get('/v1/admin/focus/samples?unlabeled=1').set(auth());
    expect(list.status).toBe(200);
    const target = list.body.samples[0];
    expect(target?.sampleId).toBeTruthy();

    const res = await f.http
      .post('/v1/admin/focus/label')
      .set(auth())
      .send({ labels: [{ sampleId: target.sampleId, correct: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(1);
  });

  // Multilingual Tier 5 (migration 0103): prove the language/script columns
  // round-trip on a real SurrealDB — the part unit tests can't cover (the
  // `language IS NONE` predicate, the conditional CONTENT, the composite-key
  // load). Off (default flag) the calibration is the global per-class one;
  // ON, the fit persists (class × language) / (class × script) rows and the
  // 0103 columns read back with the values written.
  it('rounds-trips the 0103 language/script columns through fit + persist', async () => {
    process.env.FOVEA_FOCUS_CAPTURE = '1';
    process.env.MULTILINGUAL_CALIBRATION = '1';
    try {
      // Seed a well-sampled (class=default × ru/Cyrl) cell — enough to clear
      // the per-language min-sample floor (MIN_CLASS_SAMPLES = 30).
      await surreal.withCompany(f.companyId, async (db) => {
        for (let i = 0; i < 34; i++) {
          const x = (i + 0.5) / 34;
          await db.query(
            `CREATE focus_signal_sample CONTENT {
                companyId: $c, sampleId: $s, queryClass: 'default',
                stage: 'verdict', topScore: $x, coverageScore: $x, retrievalGap: $x,
                verifierVerdict: 'none', rawConfidence: $r, correct: $correct,
                language: 'ru', script: 'Cyrl'
             }`,
            { c: f.companyId, s: randomUUID(), x, r: 0.65 * x, correct: x > 0.5 ? 1 : 0 },
          );
        }
      });

      const fit = await f.http.post('/v1/admin/focus/fit').set(auth()).send({});
      expect(fit.status).toBe(201);

      // The persisted rows carry the 0103 columns: a (class × language) row
      // (language='ru', script NONE) and a (class × script) row (script='Cyrl',
      // language NONE), alongside the bare global-per-class rows.
      const cal = await surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<
          [
            Array<{
              queryClass: string;
              language: string | null;
              script: string | null;
              thresholds: number[];
              values: number[];
            }>,
          ]
        >('SELECT queryClass, language, script, thresholds, values FROM focus_calibration');
        return rows ?? [];
      });
      const langRow = cal.find((r) => r.language === 'ru');
      expect(langRow).toBeDefined();
      expect(langRow!.script == null).toBe(true);
      expect(Array.isArray(langRow!.thresholds)).toBe(true);
      expect(langRow!.thresholds.length).toBe(langRow!.values.length);

      const scriptRow = cal.find((r) => r.script === 'Cyrl');
      expect(scriptRow).toBeDefined();
      expect(scriptRow!.language == null).toBe(true);

      // `language IS NONE AND script IS NONE` still selects the global rows —
      // the off-path (byte-identical) read.
      const globalRows = await surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ queryClass: string }>]>(
          'SELECT queryClass FROM focus_calibration WHERE language IS NONE AND script IS NONE',
        );
        return rows ?? [];
      });
      expect(globalRows.some((r) => r.queryClass === 'default')).toBe(true);
    } finally {
      delete process.env.MULTILINGUAL_CALIBRATION;
    }
  });
});
